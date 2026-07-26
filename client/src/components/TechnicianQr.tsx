import { useEffect, useState } from "react";
import QRCode from "qrcode";

/**
 * Enrollment QR for the Health Record field app.
 *
 * The technician scans this off the screen and lands in /field already
 * connected — the access token never travels over SMS or email, and it works
 * with no signal, which is where enrollment usually happens.
 *
 * The token rides in the URL *fragment*, not a query string: fragments are
 * never sent to the server, so the credential stays out of Express request
 * logs, Railway's log stream, and anything proxying in between. The PWA reads
 * it on boot and strips it from history (see field/src/main.tsx).
 */
export function enrollmentUrl(token: string): string {
  return `${window.location.origin}/field/#t=${encodeURIComponent(token)}`;
}

export function TechnicianQr({ token, name }: { token: string; name: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(enrollmentUrl(token), { width: 320, margin: 1 })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not render QR code");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (error) return <p className="mt-2 text-xs text-red-600">{error}</p>;
  if (!dataUrl) return <p className="mt-2 text-xs text-rce-muted">Rendering QR…</p>;

  return (
    <div className="mt-2 rounded bg-white p-3">
      <img src={dataUrl} alt={`Field app enrollment code for ${name}`} width={320} height={320} />
      <p className="mt-2 max-w-[320px] text-xs text-rce-muted">
        Scan with the phone’s camera and open the link in Safari or Chrome (not an in-app
        browser), then use “Add to Home Screen”. {name} will be signed in automatically.
      </p>
      <p className="mt-1 max-w-[320px] text-xs font-medium text-red-700">
        This code contains {name}’s access token — treat it like a password. Don’t screenshot or
        share it.
      </p>
    </div>
  );
}
