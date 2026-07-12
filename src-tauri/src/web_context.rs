use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use futures_util::StreamExt;
use keyring::Entry;
use reqwest::{redirect::Policy, Client, Url};
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashSet,
    net::{IpAddr, SocketAddr},
    time::Duration,
};
use tokio::net::lookup_host;

const SERVICE: &str = "dev.flowz.app";
const BRAVE_ACCOUNT: &str = "brave-search-api-key";
const MAX_HTML_BYTES: usize = 3 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES: usize = 8 * 1024 * 1024;
const MAX_EXTRACTED_CHARS: usize = 40_000;
const MAX_REDIRECTS: usize = 5;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebpageRequest {
    url: String,
    include_screenshot: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebpageResult {
    final_url: String,
    title: Option<String>,
    text: String,
    screenshot_data_url: Option<String>,
    screenshot_provider: Option<&'static str>,
    truncated: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchRequest {
    query: String,
    result_count: u8,
    freshness: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchResult {
    provider: &'static str,
    markdown: String,
    result_count: usize,
}

fn brave_entry() -> Result<Entry, String> {
    Entry::new(SERVICE, BRAVE_ACCOUNT).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn save_brave_search_key(key: String) -> Result<(), String> {
    let key = key.trim();
    if key.len() < 20 || key.chars().any(char::is_whitespace) {
        return Err("Der Brave-Search-Key ist ungültig oder zu kurz.".into());
    }
    brave_entry()?
        .set_password(key)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn brave_search_key_status() -> bool {
    brave_entry()
        .and_then(|entry| entry.get_password().map_err(|error| error.to_string()))
        .is_ok()
}

#[tauri::command]
pub fn delete_brave_search_key() -> Result<(), String> {
    brave_entry()?
        .delete_credential()
        .map_err(|error| error.to_string())
}

fn blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.is_multicast()
                || ip.is_broadcast()
                || (a == 100 && (64..=127).contains(&b))
                || (a == 192 && b == 0 && c == 0)
                || (a == 198 && matches!(b, 18 | 19))
                || (a == 192 && b == 0 && c == 2)
                || (a == 198 && b == 51 && c == 100)
                || (a == 203 && b == 0 && c == 113)
                || a >= 240
        }
        IpAddr::V6(ip) => {
            ip.to_ipv4_mapped()
                .is_some_and(|mapped| blocked_ip(IpAddr::V4(mapped)))
                || ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
                || ip.segments()[0..2] == [0x2001, 0x0db8]
        }
    }
}

fn validate_url_shape(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw.trim())
        .map_err(|_| "Bitte eine vollständige http(s)-URL eingeben.".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.username() != "" || url.password().is_some()
    {
        return Err("Nur öffentliche http(s)-URLs ohne Zugangsdaten sind erlaubt.".into());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "Die URL enthält keinen Host.".to_string())?
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
    {
        return Err("Lokale und interne Adressen dürfen nicht abgerufen werden.".into());
    }
    if url.port_or_known_default().is_none() {
        return Err("Der URL-Port wird nicht unterstützt.".into());
    }
    Ok(url)
}

async fn pinned_client(url: &Url) -> Result<Client, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "Die URL enthält keinen Host.".to_string())?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "Der URL-Port wird nicht unterstützt.".to_string())?;
    let addresses: Vec<SocketAddr> = lookup_host((host, port))
        .await
        .map_err(|_| "Der Host konnte nicht aufgelöst werden.".to_string())?
        .collect();
    if addresses.is_empty() || addresses.iter().any(|address| blocked_ip(address.ip())) {
        return Err(
            "Die URL verweist auf eine lokale, private oder nicht routbare Adresse.".into(),
        );
    }
    Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(20))
        .user_agent("FlowZ/0.1 (+https://flowz.dev)")
        .resolve_to_addrs(host, &addresses)
        .build()
        .map_err(|error| error.to_string())
}

async fn limited_bytes(response: reqwest::Response, max: usize) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > max as u64)
    {
        return Err(format!(
            "Die Antwort ist größer als {} MiB.",
            max / 1024 / 1024
        ));
    }
    let mut output = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| error.to_string())?;
        if output.len().saturating_add(chunk.len()) > max {
            return Err(format!(
                "Die Antwort überschreitet {} MiB.",
                max / 1024 / 1024
            ));
        }
        output.extend_from_slice(&chunk);
    }
    Ok(output)
}

async fn fetch_public_html(raw: &str) -> Result<(Url, Vec<u8>), String> {
    let mut url = validate_url_shape(raw)?;
    for redirect in 0..=MAX_REDIRECTS {
        let response = pinned_client(&url)
            .await?
            .get(url.clone())
            .header("Accept", "text/html,application/xhtml+xml")
            .send()
            .await
            .map_err(|error| error.to_string())?;
        if response.status().is_redirection() {
            if redirect == MAX_REDIRECTS {
                return Err("Die Webseite leitet zu oft weiter.".into());
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "Die Webseite lieferte eine ungültige Weiterleitung.".to_string())?;
            url = validate_url_shape(
                url.join(location)
                    .map_err(|_| "Die Weiterleitungs-URL ist ungültig.".to_string())?
                    .as_str(),
            )?;
            continue;
        }
        if !response.status().is_success() {
            return Err(format!(
                "Die Webseite antwortete mit HTTP {}.",
                response.status().as_u16()
            ));
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !content_type.contains("text/html") && !content_type.contains("application/xhtml+xml") {
            return Err("Die URL liefert keine HTML-Webseite.".into());
        }
        return Ok((url, limited_bytes(response, MAX_HTML_BYTES).await?));
    }
    unreachable!()
}

fn normalized_text(html: &str) -> (Option<String>, String, bool) {
    let document = Html::parse_document(html);
    let title_selector = Selector::parse("title").expect("static selector");
    let title = document
        .select(&title_selector)
        .next()
        .map(|node| node.text().collect::<Vec<_>>().join(" "))
        .map(|value| collapse_whitespace(&value))
        .filter(|value| !value.is_empty());
    let content_selector = Selector::parse("main, article, body").expect("static selector");
    let root = document.select(&content_selector).next();
    let readable_selector =
        Selector::parse("h1, h2, h3, h4, h5, h6, p, li, blockquote, figcaption, td, th, dt, dd")
            .expect("static selector");
    let selected = root
        .map(|node| {
            node.select(&readable_selector)
                .flat_map(|element| element.text())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default();
    let raw = if selected.trim().is_empty() {
        root.map(|node| node.text().collect::<Vec<_>>().join(" "))
            .unwrap_or_default()
    } else {
        selected
    };
    let text = collapse_whitespace(&raw);
    let truncated = text.chars().count() > MAX_EXTRACTED_CHARS;
    (
        title,
        text.chars().take(MAX_EXTRACTED_CHARS).collect(),
        truncated,
    )
}

fn collapse_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

async fn thum_screenshot(target: &Url) -> Result<String, String> {
    let mut url = Url::parse("https://image.thum.io/get/width/900/crop/900/noanimate/")
        .expect("valid screenshot endpoint");
    url.query_pairs_mut().append_pair("url", target.as_str());
    let response = Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?
        .get(url)
        .send()
        .await
        .map_err(|error| format!("Screenshot-Dienst nicht erreichbar: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Screenshot-Dienst antwortete mit HTTP {}.",
            response.status().as_u16()
        ));
    }
    let media_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("image/png")
        .split(';')
        .next()
        .unwrap_or("image/png")
        .to_string();
    if !media_type.starts_with("image/") {
        return Err("Screenshot-Dienst lieferte kein Bild.".into());
    }
    let bytes = limited_bytes(response, MAX_SCREENSHOT_BYTES).await?;
    Ok(format!("data:{media_type};base64,{}", BASE64.encode(bytes)))
}

#[tauri::command]
pub async fn fetch_webpage(request: WebpageRequest) -> Result<WebpageResult, String> {
    let (final_url, bytes) = fetch_public_html(&request.url).await?;
    let html = String::from_utf8_lossy(&bytes);
    let (title, text, truncated) = normalized_text(&html);
    if text.is_empty() {
        return Err("Auf der Webseite konnte kein lesbarer Text gefunden werden.".into());
    }
    let screenshot_data_url = if request.include_screenshot {
        Some(thum_screenshot(&final_url).await?)
    } else {
        None
    };
    Ok(WebpageResult {
        final_url: final_url.to_string(),
        title,
        text,
        screenshot_data_url,
        screenshot_provider: request.include_screenshot.then_some("Thum.io"),
        truncated,
    })
}

fn markdown_escape(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for character in value.chars() {
        if matches!(
            character,
            '\\' | '`'
                | '*'
                | '_'
                | '{'
                | '}'
                | '['
                | ']'
                | '('
                | ')'
                | '<'
                | '>'
                | '#'
                | '+'
                | '-'
                | '.'
                | '!'
                | '|'
        ) {
            output.push('\\');
        }
        output.push(character);
    }
    output
}

#[tauri::command]
pub async fn run_web_research(request: ResearchRequest) -> Result<ResearchResult, String> {
    let query = request.query.trim();
    if query.is_empty() || query.chars().count() > 400 || query.split_whitespace().count() > 50 {
        return Err("Die Suchanfrage muss 1–400 Zeichen und höchstens 50 Wörter enthalten.".into());
    }
    let count = request.result_count.clamp(1, 20);
    let key = brave_entry()?.get_password().map_err(|_| "Kein Brave-Search-Key gespeichert. Öffne „OpenRouter & Suche“ und hinterlege dort einen Key.".to_string())?;
    let mut url =
        Url::parse("https://api.search.brave.com/res/v1/web/search").expect("valid Brave endpoint");
    url.query_pairs_mut()
        .append_pair("q", query)
        .append_pair("count", &count.to_string())
        .append_pair("country", "DE")
        .append_pair("search_lang", "de")
        .append_pair("safesearch", "moderate");
    if let Some(value) = match request.freshness.as_str() {
        "day" => Some("pd"),
        "week" => Some("pw"),
        "month" => Some("pm"),
        "year" => Some("py"),
        _ => None,
    } {
        url.query_pairs_mut().append_pair("freshness", value);
    }
    let response = Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| error.to_string())?
        .get(url)
        .header("Accept", "application/json")
        .header("X-Subscription-Token", key)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let bytes = limited_bytes(response, 2 * 1024 * 1024).await?;
    let body: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "Brave Search lieferte keine gültige JSON-Antwort.".to_string())?;
    if !status.is_success() {
        let provider_message = body
            .pointer("/message")
            .and_then(Value::as_str)
            .map(|value| {
                collapse_whitespace(value)
                    .chars()
                    .take(300)
                    .collect::<String>()
            });
        return Err(match status.as_u16() {
            401 | 403 => "Brave Search hat den Schlüssel abgelehnt. Prüfe den gespeicherten Subscription Token.".into(),
            429 => "Brave Search hat das Anfrage-Limit erreicht. Bitte später erneut versuchen.".into(),
            code => format!("Brave Search antwortete mit HTTP {code}.{}", provider_message.map(|value| format!(" {value}")).unwrap_or_default()),
        });
    }
    let items = body
        .pointer("/web/results")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut seen = HashSet::new();
    let mut lines = vec![
        format!("## Recherche: {}", markdown_escape(query)),
        String::new(),
    ];
    let mut used = 0;
    for item in items {
        let Some(raw_url) = item.get("url").and_then(Value::as_str) else {
            continue;
        };
        let Ok(parsed_url) = Url::parse(raw_url) else {
            continue;
        };
        if !matches!(parsed_url.scheme(), "http" | "https") {
            continue;
        }
        let url = parsed_url.as_str();
        if !seen.insert(url.to_string()) {
            continue;
        }
        let title = item.get("title").and_then(Value::as_str).unwrap_or(url);
        let description = item
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("");
        lines.push(format!(
            "- [{}](<{}>){}",
            markdown_escape(title),
            url,
            if description.is_empty() {
                String::new()
            } else {
                format!(" — {}", markdown_escape(&collapse_whitespace(description)))
            }
        ));
        used += 1;
    }
    if used == 0 {
        lines.push("Keine Treffer gefunden.".into());
    }
    lines.push(String::new());
    lines.push("_Quelle: Brave Search API · Ergebnisse sind Momentaufnahmen und sollten vor Entscheidungen geprüft werden._".into());
    Ok(ResearchResult {
        provider: "Brave Search",
        markdown: lines.join("\n"),
        result_count: used,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_private_and_credentialed_urls() {
        assert!(validate_url_shape("http://localhost/admin").is_err());
        assert!(validate_url_shape("http://user:pass@example.com").is_err());
        assert!(blocked_ip("127.0.0.1".parse().unwrap()));
        assert!(blocked_ip("::1".parse().unwrap()));
        assert!(blocked_ip("::ffff:127.0.0.1".parse().unwrap()));
        assert!(blocked_ip("100.64.0.1".parse().unwrap()));
        assert!(!blocked_ip("1.1.1.1".parse().unwrap()));
    }

    #[test]
    fn extracts_and_limits_readable_html() {
        let (title, text, truncated) = normalized_text("<html><head><title> Flow Z </title></head><body><main>Hello <b>world</b></main></body></html>");
        assert_eq!(title.as_deref(), Some("Flow Z"));
        assert_eq!(text, "Hello world");
        assert!(!truncated);
    }

    #[test]
    fn escapes_untrusted_search_snippets_for_markdown() {
        assert_eq!(
            markdown_escape("[click](javascript:x) **bold**"),
            "\\[click\\]\\(javascript:x\\) \\*\\*bold\\*\\*"
        );
    }
}
