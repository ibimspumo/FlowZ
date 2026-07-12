use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::Utc;
use idna::domain_to_ascii;
use reqwest::{header, Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    net::IpAddr,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};
use uuid::Uuid;

use crate::persistence::Persistence;

const BOOTSTRAP_URL: &str = "https://data.iana.org/rdap/dns.json";
const MAX_CHECKS: usize = 20;

#[derive(Default)]
struct BootstrapCache {
    etag: Option<String>,
    services: HashMap<String, String>,
}

pub struct BrandState {
    client: Client,
    cache_path: PathBuf,
    cache: Mutex<BootstrapCache>,
    last_host_request: Mutex<HashMap<String, Instant>>,
    font_cache_path: PathBuf,
    font_cache: Mutex<HashMap<String, FontCacheEntry>>,
    font_operations: Mutex<()>,
}

impl BrandState {
    pub fn initialize(app_data: PathBuf, persistence: &Persistence) -> Result<Self, String> {
        let cache_path = app_data.join("rdap-bootstrap.json");
        let cache = read_cache(&cache_path).unwrap_or_default();
        let font_cache_path = app_data.join("google-font-cache.json");
        let font_cache = fs::read(&font_cache_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Vec<FontCacheEntry>>(&bytes).ok())
            .unwrap_or_default()
            .into_iter()
            .filter(|entry| validate_cached_entry(entry, persistence).is_ok())
            .map(|entry| (entry.font_url.clone(), entry))
            .collect();
        Ok(Self {
            client: Client::builder()
                .timeout(Duration::from_secs(15))
                .redirect(reqwest::redirect::Policy::none())
                .user_agent("FlowZ/0.1 RDAP")
                .build()
                .map_err(|e| e.to_string())?,
            cache_path,
            cache: Mutex::new(cache),
            last_host_request: Mutex::new(HashMap::new()),
            font_cache_path,
            font_cache: Mutex::new(font_cache),
            font_operations: Mutex::new(()),
        })
    }

    async fn services(&self) -> Result<HashMap<String, String>, String> {
        let etag = self
            .cache
            .lock()
            .map_err(|_| "RDAP-Cache gesperrt.")?
            .etag
            .clone();
        let mut request = self.client.get(BOOTSTRAP_URL);
        if let Some(etag) = etag {
            request = request.header(header::IF_NONE_MATCH, etag);
        }
        match request.send().await {
            Ok(response) if response.status() == StatusCode::NOT_MODIFIED => {
                return Ok(self
                    .cache
                    .lock()
                    .map_err(|_| "RDAP-Cache gesperrt.")?
                    .services
                    .clone())
            }
            Ok(response) if response.status().is_success() => {
                let response_etag = response
                    .headers()
                    .get(header::ETAG)
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_owned);
                let json: Value = response
                    .json()
                    .await
                    .map_err(|e| format!("IANA-RDAP-Bootstrap ungültig: {e}"))?;
                let services = parse_services(&json)?;
                let disk = serde_json::json!({"version":1,"source":BOOTSTRAP_URL,"etag":response_etag,"fetchedAt":Utc::now().to_rfc3339(),"services":services});
                if let Some(parent) = self.cache_path.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                write_cache_atomic(&self.cache_path, &disk)?;
                *self.cache.lock().map_err(|_| "RDAP-Cache gesperrt.")? =
                    read_cache(&self.cache_path).unwrap_or_default();
                return Ok(services);
            }
            _ => {}
        }
        let stale = self
            .cache
            .lock()
            .map_err(|_| "RDAP-Cache gesperrt.")?
            .services
            .clone();
        if stale.is_empty() {
            Err("IANA-RDAP-Bootstrap ist nicht erreichbar und es gibt keinen Cache.".into())
        } else {
            Ok(stale)
        }
    }
}

fn parse_services(json: &Value) -> Result<HashMap<String, String>, String> {
    let mut map = HashMap::new();
    for service in json
        .get("services")
        .and_then(Value::as_array)
        .ok_or("IANA-Bootstrap enthält keine Services.")?
    {
        let pair = service.as_array().ok_or("Ungültiger IANA-Service.")?;
        let tlds = pair
            .first()
            .and_then(Value::as_array)
            .ok_or("Ungültige IANA-TLD-Liste.")?;
        let base = pair
            .get(1)
            .and_then(Value::as_array)
            .and_then(|v| v.first())
            .and_then(Value::as_str)
            .ok_or("Ungültige IANA-RDAP-URL.")?;
        let url = Url::parse(base).map_err(|_| "Ungültige IANA-RDAP-URL.")?;
        if !safe_https_url(&url) {
            continue;
        }
        for tld in tlds.iter().filter_map(Value::as_str) {
            map.insert(
                tld.trim_start_matches('.').to_ascii_lowercase(),
                base.to_owned(),
            );
        }
    }
    Ok(map)
}

fn read_cache(path: &PathBuf) -> Option<BootstrapCache> {
    let value: Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    if value.get("version")?.as_u64()? != 1
        || value.get("source")?.as_str()? != BOOTSTRAP_URL
        || chrono::DateTime::parse_from_rfc3339(value.get("fetchedAt")?.as_str()?).is_err()
    {
        return None;
    }
    let services = value
        .get("services")?
        .as_object()?
        .iter()
        .filter_map(|(k, v)| {
            let raw = v.as_str()?;
            let parsed = Url::parse(raw).ok()?;
            safe_https_url(&parsed).then_some((k.clone(), raw.to_owned()))
        })
        .collect();
    Some(BootstrapCache {
        etag: value.get("etag").and_then(Value::as_str).map(str::to_owned),
        services,
    })
}

fn safe_https_url(url: &Url) -> bool {
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") {
        return false;
    }
    match host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
    {
        Ok(IpAddr::V4(ip)) => {
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.is_broadcast())
        }
        Ok(IpAddr::V6(ip)) => {
            let segments = ip.segments();
            !(ip.is_loopback()
                || ip.is_unspecified()
                || (segments[0] & 0xfe00) == 0xfc00
                || (segments[0] & 0xffc0) == 0xfe80)
        }
        Err(_) => true,
    }
}

fn write_cache_atomic(path: &PathBuf, value: &Value) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or("RDAP-Cachepfad hat kein Verzeichnis.")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = parent.join(format!(".rdap-bootstrap-{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        fs::rename(&temporary, path).map_err(|e| e.to_string())?;
        fs::File::open(parent)
            .and_then(|dir| dir.sync_all())
            .map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FontPrepareRequest {
    family: String,
    license: String,
    path: String,
    metadata_url: String,
    metadata_sha256: String,
    license_url: String,
    license_sha256: String,
    font_url: String,
    font_sha256: Option<String>,
    font_file: String,
    axes: Vec<String>,
    axis_ranges: Vec<FontAxisRange>,
    subsets: Vec<String>,
    style: String,
    weight: u16,
    variant_index: usize,
    axis_values: HashMap<String, f64>,
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FontAxisRange {
    tag: String,
    min: f64,
    max: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontPrepareResult {
    blob_hash: String,
    license_blob_hash: String,
    media_url: String,
    font_sha256: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontPreviewResult {
    media_url: String,
    font_sha256: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontCacheEntry {
    family: String,
    license: String,
    path: String,
    metadata_url: String,
    metadata_sha256: String,
    license_url: String,
    license_sha256: String,
    style: String,
    weight: u16,
    variant_index: usize,
    font_url: String,
    font_file: String,
    blob_hash: String,
    license_blob_hash: String,
    font_sha256: String,
    axes: Vec<String>,
    axis_ranges: Vec<FontAxisRange>,
    subsets: Vec<String>,
    axis_values: HashMap<String, f64>,
    size_bytes: u64,
    last_used_at: String,
}

fn cached_entry_matches_request(entry: &FontCacheEntry, request: &FontPrepareRequest) -> bool {
    entry.family == request.family
        && entry.license == request.license
        && entry.path == request.path
        && entry.metadata_url == request.metadata_url
        && entry.metadata_sha256 == request.metadata_sha256
        && entry.license_url == request.license_url
        && entry.license_sha256 == request.license_sha256
        && entry.style == request.style
        && entry.weight == request.weight
        && entry.variant_index == request.variant_index
        && entry.font_url == request.font_url
        && entry.font_file == request.font_file
        && entry.axes == request.axes
        && entry.axis_ranges == request.axis_ranges
        && entry.subsets == request.subsets
        && entry.axis_values == request.axis_values
        && request
            .font_sha256
            .as_ref()
            .is_none_or(|hash| hash == &entry.font_sha256)
}

fn validate_cached_entry(entry: &FontCacheEntry, persistence: &Persistence) -> Result<(), String> {
    let font_url = validate_pinned_google_url(&entry.font_url)?;
    let metadata_url = validate_pinned_google_url(&entry.metadata_url)?;
    let license_url = validate_pinned_google_url(&entry.license_url)?;
    let expected_root = match entry.license.as_str() {
        "OFL" => "ofl/",
        "APACHE2" => "apache/",
        "UFL" => "ufl/",
        _ => return Err("Font-Cachelizenzklasse ist ungültig.".into()),
    };
    let expected_parent = format!(
        "/google/fonts/ec0464b978de222073645d6d3366f3fdf03376d8/{}/",
        entry.path
    );
    if decoded_last_path(&font_url).as_deref() != Some(entry.font_file.as_str())
        || !entry.path.starts_with(expected_root)
        || !font_url.path().starts_with(&expected_parent)
        || !metadata_url.path().starts_with(&expected_parent)
        || !license_url.path().starts_with(&expected_parent)
        || entry.license_blob_hash != entry.license_sha256
        || !matches!(entry.license.as_str(), "OFL" | "APACHE2" | "UFL")
        || entry.family.is_empty()
        || entry.family.len() > 100
        || !matches!(entry.style.as_str(), "normal" | "italic")
        || !(1..=1000).contains(&entry.weight)
        || entry.variant_index > 63
        || entry.axes.len() > 32
        || entry.axis_ranges.len() != entry.axes.len()
        || entry.axis_ranges.iter().any(|axis| {
            axis.tag.len() != 4
                || !entry.axes.contains(&axis.tag)
                || !axis.min.is_finite()
                || !axis.max.is_finite()
                || axis.min > axis.max
        })
        || entry.axis_values.iter().any(|(tag, value)| {
            entry
                .axis_ranges
                .iter()
                .find(|axis| axis.tag == *tag)
                .is_none_or(|axis| *value < axis.min || *value > axis.max)
        })
        || entry.axis_values.values().any(|value| !value.is_finite())
    {
        return Err("Font-Cacheindex enthält einen ungültigen Vertrag.".into());
    }
    let font = persistence.blobs.read(&entry.blob_hash)?;
    if sha256(&font) != entry.font_sha256
        || entry.font_sha256 != entry.blob_hash
        || font.len() as u64 != entry.size_bytes
        || (!font.starts_with(&[0, 1, 0, 0])
            && !font.starts_with(b"OTTO")
            && !font.starts_with(b"wOF2"))
    {
        return Err("Font-Cachedatei stimmt nicht mit Hash, Größe oder Signatur überein.".into());
    }
    let expected_contract = serde_json::json!({"commit":"ec0464b978de222073645d6d3366f3fdf03376d8","family":entry.family,"path":entry.path,"metadataUrl":entry.metadata_url,"metadataSha256":entry.metadata_sha256,"fontUrl":entry.font_url,"fontSha256":entry.font_sha256,"fontFile":entry.font_file,"signature":font_signature(&font).ok_or("Fontsignatur fehlt.")?,"licenseUrl":entry.license_url,"licenseSha256":entry.license_sha256,"licenseBlobHash":entry.license_blob_hash,"licenseClass":entry.license,"variantIndex":entry.variant_index,"style":entry.style,"weight":entry.weight,"supportedAxes":entry.axis_ranges});
    let expected_selection = serde_json::json!({"axes":entry.axis_values});
    let stored = persistence
        .database
        .font_provenance(&entry.blob_hash)?
        .ok_or("Font-Provenienz fehlt.")?;
    if stored.font_hash != entry.blob_hash
        || stored.license_blob_hash != entry.license_blob_hash
        || stored.contract != expected_contract
        || !stored.selections.contains(&expected_selection)
    {
        return Err("Font-Cache stimmt nicht mit der unveränderlichen Provenienz überein.".into());
    }
    let license = persistence.blobs.read(&entry.license_blob_hash)?;
    let license = String::from_utf8_lossy(&license);
    let valid_license = match entry.license.as_str() {
        "OFL" => license.contains("SIL OPEN FONT LICENSE Version 1.1"),
        "APACHE2" => license.contains("Apache License") && license.contains("Version 2.0"),
        "UFL" => license.to_ascii_lowercase().contains("ubuntu font licence"),
        _ => false,
    };
    if !valid_license {
        return Err("Font-Cachelizenz passt nicht zum Index.".into());
    }
    Ok(())
}

fn persist_font_cache(
    state: &BrandState,
    entries: &HashMap<String, FontCacheEntry>,
) -> Result<(), String> {
    let values = entries.values().cloned().collect::<Vec<_>>();
    write_cache_atomic(
        &state.font_cache_path,
        &serde_json::to_value(values).map_err(|e| e.to_string())?,
    )
}

fn cached_font_result(
    state: &BrandState,
    request: &FontPrepareRequest,
    persistence: &Persistence,
) -> Result<Option<FontPrepareResult>, String> {
    let _operation = state
        .font_operations
        .lock()
        .map_err(|_| "Font-Cacheoperation ist gesperrt.")?;
    let Some(cached) = state
        .font_cache
        .lock()
        .map_err(|_| "Font-Cache ist gesperrt.")?
        .get(&request.font_url)
        .cloned()
    else {
        return Ok(None);
    };
    let mut entries = state
        .font_cache
        .lock()
        .map_err(|_| "Font-Cache ist gesperrt.")?;
    if cached_entry_matches_request(&cached, request)
        && validate_cached_entry(&cached, persistence).is_ok()
    {
        let mut refreshed = cached;
        refreshed.last_used_at = Utc::now().to_rfc3339();
        entries.insert(request.font_url.clone(), refreshed.clone());
        persist_font_cache(state, &entries)?;
        return Ok(Some(FontPrepareResult {
            media_url: format!("flowz-media://localhost/{}", refreshed.blob_hash),
            blob_hash: refreshed.blob_hash,
            license_blob_hash: refreshed.license_blob_hash,
            font_sha256: refreshed.font_sha256,
        }));
    }
    entries.remove(&request.font_url);
    persist_font_cache(state, &entries)?;
    Ok(None)
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn font_signature(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0, 1, 0, 0]) {
        Some("truetype-1.0")
    } else if bytes.starts_with(b"OTTO") {
        Some("opentype-cff")
    } else if bytes.starts_with(b"wOF2") {
        Some("woff2")
    } else {
        None
    }
}
fn validate_pinned_google_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|_| "Ungültige Google-Fonts-URL.")?;
    if !safe_https_url(&url)
        || url.host_str() != Some("raw.githubusercontent.com")
        || url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !["ofl", "apache", "ufl"].iter().any(|root| {
            url.path().starts_with(&format!(
                "/google/fonts/ec0464b978de222073645d6d3366f3fdf03376d8/{root}/"
            ))
        })
    {
        return Err("Schriftquelle ist nicht der gepinnte offizielle google/fonts-Commit.".into());
    }
    Ok(url)
}
fn decoded_last_path(url: &Url) -> Option<String> {
    let raw = url.path().rsplit('/').next()?;
    let bytes = raw.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(value) = u8::from_str_radix(&raw[index + 1..index + 3], 16) {
                output.push(value);
                index += 3;
                continue;
            }
        }
        output.push(bytes[index]);
        index += 1
    }
    String::from_utf8(output).ok()
}

async fn download_exact(
    client: &Client,
    url: &Url,
    expected_hash: &str,
    max: usize,
) -> Result<Vec<u8>, String> {
    if !expected_hash.chars().all(|c| c.is_ascii_hexdigit()) || expected_hash.len() != 64 {
        return Err("Ungültiger erwarteter SHA-256.".into());
    }
    let response = client
        .get(url.clone())
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() || response.url() != url {
        return Err("Die gepinnte Schriftquelle lieferte keine direkte HTTPS-Antwort.".into());
    }
    if response
        .content_length()
        .is_some_and(|size| size == 0 || size > max as u64)
    {
        return Err("Google-Fonts-Datei ist leer oder zu groß.".into());
    }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?.to_vec();
    if bytes.is_empty() || bytes.len() > max || sha256(&bytes) != expected_hash {
        return Err("Google-Fonts-Datei stimmt nicht mit dem gepinnten SHA-256 überein.".into());
    }
    Ok(bytes)
}

async fn download_pinned(
    client: &Client,
    url: &Url,
    expected_hash: Option<&str>,
    max: usize,
) -> Result<(Vec<u8>, String), String> {
    let response = client
        .get(url.clone())
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() || response.url() != url {
        return Err("Die gepinnte Schriftquelle lieferte keine direkte HTTPS-Antwort.".into());
    }
    if response
        .content_length()
        .is_some_and(|size| size == 0 || size > max as u64)
    {
        return Err("Google-Fonts-Datei ist leer oder zu groß.".into());
    }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?.to_vec();
    if bytes.is_empty() || bytes.len() > max {
        return Err("Google-Fonts-Datei ist leer oder zu groß.".into());
    }
    let actual = sha256(&bytes);
    if expected_hash.is_some_and(|expected| {
        expected.len() != 64
            || !expected.chars().all(|c| c.is_ascii_hexdigit())
            || !actual.eq_ignore_ascii_case(expected)
    }) {
        return Err(
            "Google-Fonts-Datei stimmt nicht mit dem gespeicherten SHA-256 überein.".into(),
        );
    }
    Ok((bytes, actual))
}

fn validate_font_request_shape(request: &FontPrepareRequest) -> Result<(Url, Url, Url), String> {
    if request.family.is_empty()
        || request.family.len() > 100
        || request.axes.len() > 32
        || request.axis_ranges.len() != request.axes.len()
        || request.axis_ranges.iter().any(|axis| {
            axis.tag.len() != 4
                || !request.axes.contains(&axis.tag)
                || !axis.min.is_finite()
                || !axis.max.is_finite()
                || axis.min > axis.max
        })
        || request.subsets.len() > 80
        || !matches!(request.license.as_str(), "OFL" | "APACHE2" | "UFL")
        || !matches!(request.style.as_str(), "normal" | "italic")
        || request.weight < 1
        || request.weight > 1000
        || request.variant_index > 63
        || request.axis_values.len() > 32
        || request.axis_values.values().any(|value| !value.is_finite())
        || request.axis_values.iter().any(|(tag, value)| {
            request
                .axis_ranges
                .iter()
                .find(|axis| axis.tag == *tag)
                .is_none_or(|axis| *value < axis.min || *value > axis.max)
        })
        || !["ofl/", "apache/", "ufl/"]
            .iter()
            .any(|prefix| request.path.starts_with(prefix))
        || request.font_file.contains(['/', '\\'])
    {
        return Err("Ungültiger Font-Katalogeintrag.".into());
    }
    let metadata_url = validate_pinned_google_url(&request.metadata_url)?;
    let license_url = validate_pinned_google_url(&request.license_url)?;
    let font_url = validate_pinned_google_url(&request.font_url)?;
    let expected_parent = format!(
        "/google/fonts/ec0464b978de222073645d6d3366f3fdf03376d8/{}/",
        request.path
    );
    if !metadata_url.path().starts_with(&expected_parent)
        || !license_url.path().starts_with(&expected_parent)
        || !font_url.path().starts_with(&expected_parent)
        || decoded_last_path(&font_url).as_deref() != Some(request.font_file.as_str())
    {
        return Err(
            "Font-Dateien passen nicht zur gewählten gepinnten Familie und Variante.".into(),
        );
    }
    Ok((metadata_url, license_url, font_url))
}

async fn validate_and_download_font(
    request: &FontPrepareRequest,
    client: &Client,
) -> Result<(Vec<u8>, Vec<u8>, String), String> {
    let (metadata_url, license_url, font_url) = validate_font_request_shape(request)?;
    let metadata =
        download_exact(client, &metadata_url, &request.metadata_sha256, 512 * 1024).await?;
    let metadata_text =
        std::str::from_utf8(&metadata).map_err(|_| "METADATA.pb ist kein UTF-8.".to_string())?;
    if !metadata_text.contains(&format!("name: \"{}\"", request.family))
        || !metadata_text.contains(&format!("filename: \"{}\"", request.font_file))
        || request
            .axes
            .iter()
            .any(|axis| !metadata_text.contains(&format!("tag: \"{axis}\"")))
        || request
            .subsets
            .iter()
            .any(|subset| !metadata_text.contains(&format!("subsets: \"{subset}\"")))
    {
        return Err("METADATA.pb passt nicht zum gepinnten Katalogeintrag.".into());
    }
    let marker = format!("filename: \"{}\"", request.font_file);
    let position = metadata_text
        .find(&marker)
        .ok_or("Gewählte Fontvariante fehlt in METADATA.pb.")?;
    let block_start = metadata_text[..position]
        .rfind("fonts {")
        .ok_or("Fontvariantenblock fehlt.")?;
    let variant = &metadata_text[block_start..position + marker.len()];
    if !variant.contains(&format!("style: \"{}\"", request.style))
        || !variant.contains(&format!("weight: {}", request.weight))
    {
        return Err("Stil oder Gewicht passen nicht zur gewählten Fontvariante.".into());
    }
    let license = download_exact(client, &license_url, &request.license_sha256, 128 * 1024).await?;
    let license_text = String::from_utf8_lossy(&license);
    let valid_license = match request.license.as_str() {
        "OFL" => license_text.contains("SIL OPEN FONT LICENSE Version 1.1"),
        "APACHE2" => {
            license_text.contains("Apache License") && license_text.contains("Version 2.0")
        }
        "UFL" => license_text
            .to_ascii_lowercase()
            .contains("ubuntu font licence"),
        _ => false,
    };
    if !valid_license {
        return Err("Die Lizenzdatei passt nicht zum Katalogeintrag.".into());
    }
    let (font, hash) = download_pinned(
        client,
        &font_url,
        request.font_sha256.as_deref(),
        12 * 1024 * 1024,
    )
    .await?;
    if !font.starts_with(&[0, 1, 0, 0]) && !font.starts_with(b"OTTO") && !font.starts_with(b"wOF2")
    {
        return Err("Die gepinnte Datei ist keine TrueType/OpenType-Schrift.".into());
    }
    Ok((font, license, hash))
}

#[tauri::command]
pub async fn brand_preview_font(
    request: FontPrepareRequest,
    state: tauri::State<'_, BrandState>,
) -> Result<FontPreviewResult, String> {
    let (font, _, font_sha256) = validate_and_download_font(&request, &state.client).await?;
    Ok(FontPreviewResult {
        media_url: format!("data:font/ttf;base64,{}", BASE64.encode(font)),
        font_sha256,
    })
}

#[tauri::command]
pub async fn brand_prepare_font(
    request: FontPrepareRequest,
    state: tauri::State<'_, BrandState>,
    persistence: tauri::State<'_, Persistence>,
) -> Result<FontPrepareResult, String> {
    let (metadata_url, license_url, font_url) = validate_font_request_shape(&request)?;
    if let Some(cached) = cached_font_result(&state, &request, &persistence)? {
        return Ok(cached);
    }
    let metadata = download_exact(
        &state.client,
        &metadata_url,
        &request.metadata_sha256,
        512 * 1024,
    )
    .await?;
    let metadata_text =
        std::str::from_utf8(&metadata).map_err(|_| "METADATA.pb ist kein UTF-8.".to_string())?;
    if !metadata_text.contains(&format!("name: \"{}\"", request.family))
        || !metadata_text.contains(&format!("filename: \"{}\"", request.font_file))
        || request
            .axes
            .iter()
            .any(|axis| !metadata_text.contains(&format!("tag: \"{axis}\"")))
        || request
            .subsets
            .iter()
            .any(|subset| !metadata_text.contains(&format!("subsets: \"{subset}\"")))
    {
        return Err("METADATA.pb passt nicht zum gepinnten Katalogeintrag.".into());
    }
    let marker = format!("filename: \"{}\"", request.font_file);
    let position = metadata_text
        .find(&marker)
        .ok_or("Gewählte Fontvariante fehlt in METADATA.pb.")?;
    let block_start = metadata_text[..position]
        .rfind("fonts {")
        .ok_or("Fontvariantenblock fehlt.")?;
    let variant = &metadata_text[block_start..position + marker.len()];
    if !variant.contains(&format!("style: \"{}\"", request.style))
        || !variant.contains(&format!("weight: {}", request.weight))
    {
        return Err("Stil oder Gewicht passen nicht zur gewählten Fontvariante.".into());
    }
    let license = download_exact(
        &state.client,
        &license_url,
        &request.license_sha256,
        128 * 1024,
    )
    .await?;
    let license_text = String::from_utf8_lossy(&license);
    let valid_license = match request.license.as_str() {
        "OFL" => license_text.contains("SIL OPEN FONT LICENSE Version 1.1"),
        "APACHE2" => {
            license_text.contains("Apache License") && license_text.contains("Version 2.0")
        }
        "UFL" => license_text
            .to_ascii_lowercase()
            .contains("ubuntu font licence"),
        _ => false,
    };
    if !valid_license {
        return Err("Die Lizenzdatei passt nicht zum Katalogeintrag.".into());
    }
    let (font, font_sha256) = download_pinned(
        &state.client,
        &font_url,
        request.font_sha256.as_deref(),
        12 * 1024 * 1024,
    )
    .await?;
    if !font.starts_with(&[0, 1, 0, 0]) && !font.starts_with(b"OTTO") && !font.starts_with(b"wOF2")
    {
        return Err("Die gepinnte Datei ist keine TrueType/OpenType-Schrift.".into());
    }
    let font_blob = persistence.blobs.import_bytes(
        &font,
        "font/ttf".into(),
        Some(request.font_file.clone()),
    )?;
    let license_blob = persistence.blobs.import_bytes(
        &license,
        "text/plain".into(),
        Some(format!("{}-OFL.txt", request.family.replace(' ', "-"))),
    )?;
    persistence.database.upsert_blob(&font_blob)?;
    persistence.database.upsert_blob(&license_blob)?;
    if license_blob.hash != request.license_sha256 {
        return Err("Lizenz-CAS-Hash stimmt nicht mit der gepinnten Lizenz überein.".into());
    }
    let provenance = serde_json::json!({"commit":"ec0464b978de222073645d6d3366f3fdf03376d8","family":request.family,"path":request.path,"metadataUrl":request.metadata_url,"metadataSha256":request.metadata_sha256,"fontUrl":request.font_url,"fontSha256":font_sha256,"fontFile":request.font_file,"signature":font_signature(&font).ok_or("Fontsignatur fehlt.")?,"licenseUrl":request.license_url,"licenseSha256":request.license_sha256,"licenseBlobHash":license_blob.hash,"licenseClass":request.license,"variantIndex":request.variant_index,"style":request.style,"weight":request.weight,"supportedAxes":request.axis_ranges});
    let selection = serde_json::json!({"axes":request.axis_values});
    persistence.database.record_font_provenance(
        &font_blob.hash,
        &license_blob.hash,
        &provenance,
        &selection,
    )?;
    let entry = FontCacheEntry {
        family: provenance["family"].as_str().unwrap().into(),
        license: provenance["licenseClass"].as_str().unwrap().into(),
        path: provenance["path"].as_str().unwrap().into(),
        metadata_url: provenance["metadataUrl"].as_str().unwrap().into(),
        metadata_sha256: provenance["metadataSha256"].as_str().unwrap().into(),
        license_url: provenance["licenseUrl"].as_str().unwrap().into(),
        license_sha256: provenance["licenseSha256"].as_str().unwrap().into(),
        style: provenance["style"].as_str().unwrap().into(),
        weight: request.weight,
        variant_index: request.variant_index,
        font_url: provenance["fontUrl"].as_str().unwrap().into(),
        font_file: provenance["fontFile"].as_str().unwrap().into(),
        blob_hash: font_blob.hash.clone(),
        license_blob_hash: license_blob.hash.clone(),
        font_sha256: font_sha256.clone(),
        axes: request.axes,
        axis_ranges: serde_json::from_value(provenance["supportedAxes"].clone())
            .map_err(|error| error.to_string())?,
        subsets: request.subsets,
        axis_values: serde_json::from_value(selection["axes"].clone())
            .map_err(|error| error.to_string())?,
        size_bytes: font.len() as u64,
        last_used_at: Utc::now().to_rfc3339(),
    };
    let _operation = state
        .font_operations
        .lock()
        .map_err(|_| "Font-Cacheoperation ist gesperrt.")?;
    let mut entries = state
        .font_cache
        .lock()
        .map_err(|_| "Font-Cache ist gesperrt.")?;
    entries.insert(entry.font_url.clone(), entry);
    persist_font_cache(&state, &entries)?;
    Ok(FontPrepareResult {
        media_url: format!("flowz-media://localhost/{}", font_blob.hash),
        blob_hash: font_blob.hash,
        license_blob_hash: license_blob.hash,
        font_sha256,
    })
}

#[tauri::command]
pub fn brand_font_cache_list(
    state: tauri::State<'_, BrandState>,
    persistence: tauri::State<'_, Persistence>,
) -> Result<Vec<FontCacheEntry>, String> {
    let _operation = state
        .font_operations
        .lock()
        .map_err(|_| "Font-Cacheoperation ist gesperrt.")?;
    let mut entries = state
        .font_cache
        .lock()
        .map_err(|_| "Font-Cache ist gesperrt.")?;
    let before = entries.len();
    entries.retain(|_, entry| validate_cached_entry(entry, &persistence).is_ok());
    if entries.len() != before {
        persist_font_cache(&state, &entries)?;
    }
    let mut values = entries.values().cloned().collect::<Vec<_>>();
    values.sort_by(|a, b| b.last_used_at.cmp(&a.last_used_at));
    Ok(values)
}

#[tauri::command]
pub fn brand_font_cache_delete(
    blob_hash: String,
    state: tauri::State<'_, BrandState>,
    persistence: tauri::State<'_, Persistence>,
) -> Result<(), String> {
    let _operation = state
        .font_operations
        .lock()
        .map_err(|_| "Font-Cacheoperation ist gesperrt.")?;
    if blob_hash.len() != 64 || !blob_hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("Ungültiger Font-Hash.".into());
    }
    let mut entries = state
        .font_cache
        .lock()
        .map_err(|_| "Font-Cache ist gesperrt.")?;
    let removed = entries
        .values()
        .find(|entry| entry.blob_hash == blob_hash)
        .cloned()
        .ok_or("Schrift ist nicht im Font-Cache.")?;
    persistence.database.delete_font_cache_blobs_atomic(
        &blob_hash,
        &removed.license_blob_hash,
        || {
            for summary in persistence.projects.list()? {
                if let Ok(project) = persistence.projects.open(&summary.id) {
                    let encoded = serde_json::to_string(&project.project)
                        .map_err(|error| error.to_string())?;
                    if encoded.contains(&blob_hash) || encoded.contains(&removed.license_blob_hash)
                    {
                        return Err("Diese Schrift wird noch von einem Projekt verwendet.".into());
                    }
                }
            }
            Ok(())
        },
        |hash| persistence.blobs.remove_untracked(hash),
    )?;
    entries.retain(|_, entry| entry.blob_hash != blob_hash);
    persist_font_cache(&state, &entries)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainCheckRequest {
    pub labels: Vec<String>,
    pub tlds: Vec<String>,
    pub privacy_consent: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainCheck {
    domain: String,
    unicode_domain: String,
    tld: String,
    status: String,
    checked_at: String,
    rdap_url: Option<String>,
    note: String,
}

fn invalid(unicode_domain: String, tld: String, note: &str) -> DomainCheck {
    DomainCheck {
        domain: unicode_domain.clone(),
        unicode_domain,
        tld,
        status: "invalid".into(),
        checked_at: Utc::now().to_rfc3339(),
        rdap_url: None,
        note: note.into(),
    }
}

fn classify_rdap_status(status: StatusCode) -> (&'static str, &'static str) {
    if status.is_success() {
        ("registered", "RDAP liefert einen registrierten Datensatz.")
    } else if status == StatusCode::NOT_FOUND {
        ("not-found","RDAP liefert derzeit keinen Datensatz; das ist keine Kauf- oder Verfügbarkeitsgarantie.")
    } else if status == StatusCode::TOO_MANY_REQUESTS {
        (
            "rate-limited",
            "Der RDAP-Dienst begrenzt Anfragen. Später erneut prüfen.",
        )
    } else {
        (
            "unknown",
            "Der RDAP-Dienst lieferte keine eindeutige Antwort.",
        )
    }
}

fn retry_after(response: &reqwest::Response) -> Duration {
    let seconds = response
        .headers()
        .get(header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(1)
        .clamp(1, 3);
    Duration::from_secs(seconds)
}

#[tauri::command]
pub async fn brand_check_domains(
    request: DomainCheckRequest,
    state: tauri::State<'_, BrandState>,
) -> Result<Vec<DomainCheck>, String> {
    if !request.privacy_consent {
        return Err("Bestätige vor der Prüfung, dass die Domainnamen an öffentliche RDAP-Dienste übertragen werden.".into());
    }
    if request.labels.is_empty()
        || request.labels.len().saturating_mul(request.tlds.len()) > MAX_CHECKS
    {
        return Err("Pro Lauf sind 1 bis 20 Domainprüfungen erlaubt.".into());
    }
    let services = state.services().await?;
    let mut checks = Vec::new();
    for raw_label in request.labels {
        for raw_tld in &request.tlds {
            let label = raw_label.trim().trim_matches('.');
            let tld = raw_tld.trim().trim_start_matches('.').to_ascii_lowercase();
            let unicode_domain = format!("{label}.{tld}");
            let ascii = match domain_to_ascii(&unicode_domain) {
                Ok(value) => value.to_ascii_lowercase(),
                Err(_) => {
                    checks.push(invalid(
                        unicode_domain,
                        tld,
                        "Der Domainname ist nach IDNA ungültig.",
                    ));
                    continue;
                }
            };
            if label.is_empty()
                || ascii.len() > 253
                || ascii.split('.').any(|part| {
                    part.is_empty()
                        || part.len() > 63
                        || part.starts_with('-')
                        || part.ends_with('-')
                })
            {
                checks.push(invalid(
                    unicode_domain,
                    tld,
                    "Der Domainname verletzt DNS-Labelregeln.",
                ));
                continue;
            }
            let Some(base) = services.get(&tld) else {
                checks.push(DomainCheck {
                    domain: ascii,
                    unicode_domain,
                    tld,
                    status: "unsupported".into(),
                    checked_at: Utc::now().to_rfc3339(),
                    rdap_url: None,
                    note: "IANA nennt keinen RDAP-Dienst für diese Endung.".into(),
                });
                continue;
            };
            let url = Url::parse(base)
                .and_then(|url| url.join(&format!("domain/{ascii}")))
                .map_err(|_| "Ungültige RDAP-Abfrage-URL.")?;
            let host = url.host_str().unwrap_or_default().to_owned();
            let wait = {
                let mut last = state
                    .last_host_request
                    .lock()
                    .map_err(|_| "RDAP-Ratelimit gesperrt.")?;
                let wait = last
                    .get(&host)
                    .and_then(|at| Duration::from_millis(350).checked_sub(at.elapsed()));
                last.insert(host.clone(), Instant::now());
                wait
            };
            if let Some(wait) = wait {
                tokio::time::sleep(wait).await;
            }
            let checked_at = Utc::now().to_rfc3339();
            let mut response = state.client.get(url.clone()).send().await;
            if let Ok(rate_limited) = &response {
                if rate_limited.status() == StatusCode::TOO_MANY_REQUESTS {
                    tokio::time::sleep(retry_after(rate_limited)).await;
                    response = state.client.get(url.clone()).send().await;
                }
            }
            let (status, note) = match response {
                Ok(r) => classify_rdap_status(r.status()),
                Err(_) => ("unknown", "Der RDAP-Dienst war nicht erreichbar."),
            };
            checks.push(DomainCheck {
                domain: ascii,
                unicode_domain,
                tld,
                status: status.into(),
                checked_at,
                rdap_url: Some(url.to_string()),
                note: note.into(),
            });
        }
    }
    Ok(checks)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_iana_and_rejects_insecure_services() {
        let value = serde_json::json!({"services":[[["com"],["https://rdap.example/"]],[["bad"],["http://bad/"]]]});
        let map = parse_services(&value).unwrap();
        assert_eq!(map.get("com").unwrap(), "https://rdap.example/");
        assert!(!map.contains_key("bad"));
    }
    #[test]
    fn idna_and_label_rules_are_deterministic() {
        assert_eq!(domain_to_ascii("münchen.de").unwrap(), "xn--mnchen-3ya.de");
        assert!(domain_to_ascii("\u{200d}.com").is_err());
    }
    #[test]
    fn mocked_rdap_statuses_never_claim_free() {
        assert_eq!(classify_rdap_status(StatusCode::OK).0, "registered");
        assert_eq!(classify_rdap_status(StatusCode::NOT_FOUND).0, "not-found");
        assert_eq!(
            classify_rdap_status(StatusCode::TOO_MANY_REQUESTS).0,
            "rate-limited"
        );
        assert_ne!(classify_rdap_status(StatusCode::NOT_FOUND).0, "free");
    }
    #[test]
    fn rejects_downgrade_file_localhost_and_private_ip_urls() {
        for raw in [
            "http://rdap.example/",
            "file:///tmp/rdap",
            "https://localhost/",
            "https://127.0.0.1/",
            "https://10.0.0.4/",
            "https://[::1]/",
            "https://[fd00::1]/",
        ] {
            assert!(!safe_https_url(&Url::parse(raw).unwrap()), "{raw}");
        }
        assert!(safe_https_url(
            &Url::parse("https://rdap.example/").unwrap()
        ));
    }
    #[test]
    fn cache_requires_exact_version_source_timestamp_and_safe_services() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("cache.json");
        let valid = serde_json::json!({"version":1,"source":BOOTSTRAP_URL,"etag":"x","fetchedAt":"2026-07-12T08:00:00Z","services":{"com":"https://rdap.example/","bad":"https://127.0.0.1/"}});
        write_cache_atomic(&path, &valid).unwrap();
        let cache = read_cache(&path).unwrap();
        assert_eq!(cache.services.len(), 1);
        assert!(cache.services.contains_key("com"));
        let invalid = serde_json::json!({"version":2,"source":BOOTSTRAP_URL,"fetchedAt":"2026-07-12T08:00:00Z","services":{}});
        write_cache_atomic(&path, &invalid).unwrap();
        assert!(read_cache(&path).is_none());
    }
    #[test]
    fn font_urls_are_exactly_pinned_to_official_license_roots() {
        let commit = "ec0464b978de222073645d6d3366f3fdf03376d8";
        for root in ["ofl", "apache", "ufl"] {
            assert!(validate_pinned_google_url(&format!(
                "https://raw.githubusercontent.com/google/fonts/{commit}/{root}/inter/Inter.ttf"
            ))
            .is_ok())
        }
        for raw in [
            "https://raw.githubusercontent.com/google/fonts/main/ofl/inter/Inter.ttf".to_string(),
            format!("https://raw.githubusercontent.com/evil/fonts/{commit}/ofl/inter/Inter.ttf"),
            format!("https://raw.githubusercontent.com/google/fonts/{commit}/catalog/inter.ttf"),
            format!(
                "https://raw.githubusercontent.com/google/fonts/{commit}/ofl/inter/Inter.ttf?raw=1"
            ),
        ] {
            assert!(validate_pinned_google_url(&raw).is_err(), "{raw}")
        }
    }
    #[test]
    fn font_cache_index_roundtrips_without_binary_payloads() {
        let temp = tempfile::tempdir().unwrap();
        let persistence = Persistence::initialize(temp.path()).unwrap();
        let font_bytes = [0, 1, 0, 0, 1, 2, 3, 4];
        let license_bytes = b"SIL OPEN FONT LICENSE Version 1.1";
        let font_blob = persistence
            .blobs
            .import_bytes(&font_bytes, "font/ttf".into(), Some("Inter.ttf".into()))
            .unwrap();
        let license_blob = persistence
            .blobs
            .import_bytes(license_bytes, "text/plain".into(), Some("OFL.txt".into()))
            .unwrap();
        persistence.database.upsert_blob(&font_blob).unwrap();
        persistence.database.upsert_blob(&license_blob).unwrap();
        let state = BrandState::initialize(temp.path().to_owned(), &persistence).unwrap();
        let commit = "ec0464b978de222073645d6d3366f3fdf03376d8";
        let entry = FontCacheEntry {
            family: "Inter".into(),
            license: "OFL".into(),
            path: "ofl/inter".into(),
            metadata_url: format!(
                "https://raw.githubusercontent.com/google/fonts/{commit}/ofl/inter/METADATA.pb"
            ),
            metadata_sha256: "c".repeat(64),
            license_url: format!(
                "https://raw.githubusercontent.com/google/fonts/{commit}/ofl/inter/OFL.txt"
            ),
            license_sha256: license_blob.hash.clone(),
            style: "normal".into(),
            weight: 400,
            variant_index: 0,
            font_url: format!(
                "https://raw.githubusercontent.com/google/fonts/{commit}/ofl/inter/Inter.ttf"
            ),
            font_file: "Inter.ttf".into(),
            blob_hash: font_blob.hash.clone(),
            license_blob_hash: license_blob.hash,
            font_sha256: font_blob.hash,
            axes: vec![],
            axis_ranges: vec![],
            subsets: vec!["latin".into()],
            axis_values: HashMap::new(),
            size_bytes: font_bytes.len() as u64,
            last_used_at: Utc::now().to_rfc3339(),
        };
        let request = FontPrepareRequest {
            family: entry.family.clone(),
            license: entry.license.clone(),
            path: entry.path.clone(),
            metadata_url: entry.metadata_url.clone(),
            metadata_sha256: entry.metadata_sha256.clone(),
            license_url: entry.license_url.clone(),
            license_sha256: entry.license_sha256.clone(),
            font_url: entry.font_url.clone(),
            font_sha256: Some(entry.font_sha256.clone()),
            font_file: entry.font_file.clone(),
            axes: entry.axes.clone(),
            axis_ranges: entry.axis_ranges.clone(),
            subsets: entry.subsets.clone(),
            style: entry.style.clone(),
            weight: entry.weight,
            variant_index: entry.variant_index,
            axis_values: entry.axis_values.clone(),
        };
        assert!(cached_entry_matches_request(&entry, &request));
        let mut wrong = request;
        wrong.family = "Poisoned".into();
        assert!(!cached_entry_matches_request(&entry, &wrong));
        let contract = serde_json::json!({"commit":commit,"family":entry.family,"path":entry.path,"metadataUrl":entry.metadata_url,"metadataSha256":entry.metadata_sha256,"fontUrl":entry.font_url,"fontSha256":entry.font_sha256,"fontFile":entry.font_file,"signature":"truetype-1.0","licenseUrl":entry.license_url,"licenseSha256":entry.license_sha256,"licenseBlobHash":entry.license_blob_hash,"licenseClass":entry.license,"variantIndex":entry.variant_index,"style":entry.style,"weight":entry.weight,"supportedAxes":entry.axis_ranges});
        persistence
            .database
            .record_font_provenance(
                &entry.blob_hash,
                &entry.license_blob_hash,
                &contract,
                &serde_json::json!({"axes":entry.axis_values}),
            )
            .unwrap();
        let entries = HashMap::from([(entry.font_url.clone(), entry)]);
        persist_font_cache(&state, &entries).unwrap();
        let reopened = BrandState::initialize(temp.path().to_owned(), &persistence).unwrap();
        assert_eq!(reopened.font_cache.lock().unwrap().len(), 1);
        assert!(
            !fs::read_to_string(temp.path().join("google-font-cache.json"))
                .unwrap()
                .contains("base64")
        );
    }
}
