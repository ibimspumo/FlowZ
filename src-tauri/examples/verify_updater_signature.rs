use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use minisign_verify::{PublicKey, Signature};
use serde_json::Value;
use std::{env, fs};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    if args.len() != 4 {
        return Err(
            "usage: verify_updater_signature <tauri.conf.json> <artifact> <signature>".into(),
        );
    }
    let config: Value = serde_json::from_slice(&fs::read(&args[1])?)?;
    let encoded = config
        .pointer("/plugins/updater/pubkey")
        .and_then(Value::as_str)
        .ok_or("updater public key missing from Tauri configuration")?;
    let public_document = String::from_utf8(BASE64.decode(encoded)?)?;
    let public_key = PublicKey::decode(&public_document)?;
    let encoded_signature = fs::read_to_string(&args[3])?;
    let signature_document = String::from_utf8(BASE64.decode(encoded_signature.trim())?)?;
    let signature = Signature::decode(&signature_document)?;
    let bytes = fs::read(&args[2])?;
    public_key.verify(&bytes, &signature, false)?;
    println!("Updater signature matches the public key embedded in tauri.conf.json.");
    Ok(())
}
