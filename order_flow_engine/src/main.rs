use std::env;
use std::io::{self, Write};
use std::time::Duration;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::time::sleep;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};
use url::Url;

#[derive(Serialize, Deserialize, Debug, Clone)]
struct HLTrade {
    coin: String,
    side: String, // "B" (Buy / Buyer-initiated) or "S" (Sell)
    px: String,   // Price (string)
    sz: String,   // Size (string)
    time: u64,    // Timestamp in ms
    hash: String,
}

#[derive(Deserialize, Debug)]
#[serde(untagged)]
enum HLResponse {
    Trades {
        channel: String,
        data: Vec<HLTrade>,
    },
    Other {
        // Fallback to ignore subscription confirmations or heartbeats
        channel: Option<String>,
    },
}

#[derive(Serialize, Debug)]
struct ProcessedTrade {
    coin: String,
    price: f64,
    size: f64,
    side: String,
    time: u64,
    cvd: f64,
    vwap: f64,
}

#[tokio::main]
async fn main() {
    // Determine target coin from command line argument
    let args: Vec<String> = env::args().collect();
    let coin = if args.len() > 1 {
        args[1].clone().upper_clean()
    } else {
        "BTC".to_string()
    };

    eprintln!("Order Flow Engine starting for coin: {}", coin);

    // Run the WebSocket client loop with auto-reconnection
    let mut cvd = 0.0;
    let mut total_value = 0.0;
    let mut total_volume = 0.0;

    let ws_url = "wss://api.hyperliquid.xyz/ws";
    
    loop {
        eprintln!("Connecting to Hyperliquid WebSocket: {}", ws_url);
        
        let url = match Url::parse(ws_url) {
            Ok(u) => u,
            Err(e) => {
                eprintln!("Failed to parse WS URL: {}", e);
                sleep(Duration::from_secs(5)).await;
                continue;
            }
        };

        match connect_async(url).await {
            Ok((ws_stream, _)) => {
                eprintln!("Connected successfully. Subscribing to trades for {}...", coin);
                let (mut write, mut read) = ws_stream.split();

                // Send subscription message
                let sub_msg = serde_json::json!({
                    "method": "subscribe",
                    "subscription": {
                        "type": "trades",
                        "coin": coin
                    }
                });

                if let Err(e) = write.send(Message::Text(sub_msg.to_string())).await {
                    eprintln!("Failed to send subscription: {}", e);
                    sleep(Duration::from_secs(2)).await;
                    continue;
                }

                // Listen for messages
                while let Some(message_result) = read.next().await {
                    match message_result {
                        Ok(Message::Text(text)) => {
                            // Try to deserialize trade list
                            if let Ok(HLResponse::Trades { channel, data }) = serde_json::from_str::<HLResponse>(&text) {
                                if channel == "trades" {
                                    for t in data {
                                        // Parse values
                                        let price: f64 = match t.px.parse() {
                                            Ok(p) => p,
                                            Err(_) => continue,
                                        };
                                        let size: f64 = match t.sz.parse() {
                                            Ok(s) => s,
                                            Err(_) => continue,
                                        };

                                        // CVD calculation (Buyer initiated adds, Seller initiated subtracts)
                                        if t.side == "B" {
                                            cvd += size;
                                        } else if t.side == "S" {
                                            cvd -= size;
                                        }

                                        // VWAP calculation
                                        total_value += price * size;
                                        total_volume += size;
                                        let vwap = if total_volume > 0.0 {
                                            total_value / total_volume
                                        } else {
                                            price
                                        };

                                        // Output to stdout as JSON
                                        let processed = ProcessedTrade {
                                            coin: t.coin.clone(),
                                            price,
                                            size,
                                            side: t.side.clone(),
                                            time: t.time,
                                            cvd,
                                            vwap,
                                        };

                                        if let Ok(json_out) = serde_json::to_string(&processed) {
                                            println!("{}", json_out);
                                            let _ = io::stdout().flush();
                                        }
                                    }
                                }
                            }
                        }
                        Ok(Message::Close(_)) => {
                            eprintln!("Connection closed by server.");
                            break;
                        }
                        Err(e) => {
                            eprintln!("WebSocket read error: {}", e);
                            break;
                        }
                        _ => {} // Ignore binary, ping, pong, etc.
                    }
                }
            }
            Err(e) => {
                eprintln!("Failed to connect: {}", e);
            }
        }

        eprintln!("Reconnecting in 5 seconds...");
        sleep(Duration::from_secs(5)).await;
    }
}

// Helper trait to clean up coin strings
trait CoinClean {
    fn upper_clean(&self) -> String;
}

impl CoinClean for String {
    fn upper_clean(&self) -> String {
        let mut s = self.trim().to_uppercase();
        for suffix in &["USDT", "USD"] {
            if s.ends_with(suffix) && s != *suffix {
                s = s[..s.len() - suffix.len()].to_string();
            }
        }
        s
    }
}
