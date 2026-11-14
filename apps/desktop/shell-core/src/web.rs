//! The web surface the exe pins: the CSP every page gets as a header, and the browser arguments
//! every window gets. The static test (`apps/desktop/tests/capabilities.test.ts`) reads both
//! strings from this file and compares them with `tauri.conf.json` and the design.

/// The CSP, also in `tauri.conf.json` as `app.security.csp`, which is what Tauri sends.
pub const CSP: &str = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost; worker-src blob:; frame-src 'none'; child-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; webrtc 'block'";

/// Every window's browser arguments, with `{sink}` for the sink proxy's port. WebView2 windows that
/// share a data folder must share these, so one helper builds every window.
pub const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required --proxy-server=http://127.0.0.1:{sink} --proxy-bypass-list=<-loopback> --force-webrtc-ip-handling-policy=disable_non_proxied_udp --dns-prefetch-disable";

pub fn browser_args(sink_port: u16) -> String {
    BROWSER_ARGS.replace("{sink}", &sink_port.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sink_port_is_the_only_hole() {
        let a = browser_args(51234);
        assert!(a.contains("--proxy-server=http://127.0.0.1:51234 "));
        assert!(!a.contains('{'));
        assert_eq!(a.matches("--").count(), 6);
        assert!(a.contains("--proxy-bypass-list=<-loopback>"), "no implicit loopback bypass");
    }

    #[test]
    fn the_csp_closes_the_network_and_frames() {
        for d in ["connect-src 'self' ipc: http://ipc.localhost;", "worker-src blob:;", "frame-src 'none'", "form-action 'none'", "object-src 'none'", "webrtc 'block'"] {
            assert!(CSP.contains(d), "{d}");
        }
        assert!(!CSP.contains("unsafe-eval'") || CSP.contains("'wasm-unsafe-eval'"));
        assert!(!CSP.contains("'unsafe-eval'"));
        assert!(!CSP.contains("script-src 'self' 'unsafe-inline'"));
    }
}
