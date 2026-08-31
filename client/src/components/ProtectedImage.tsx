import { useEffect, useState } from "react";
import { fetchProtectedObjectUrl } from "../lib/api";

/**
 * An image that lives behind the session.
 *
 * Browsers don't attach an Authorization header to `<img src>` or to a plain
 * link, so pointing either at a protected endpoint yields a 401 and a broken
 * image. That is what was happening to inspection photo evidence: it rendered in
 * development, where auth is inert, and silently failed in production.
 *
 * The alternative — putting the session token in the URL — is what this codebase
 * is moving away from, because addresses end up in server logs and browser
 * history in a way headers don't.
 *
 * So the bytes are fetched properly and handed to the DOM as an object URL,
 * which also gives the full-size link something to open that needs no auth of
 * its own.
 */
export function ProtectedImage({
  path, alt, className, linkToFullSize = true, onClick,
}: {
  path: string;
  alt: string;
  className?: string;
  linkToFullSize?: boolean;
  /** When set, the image is a click target (e.g. opens the PhotoLightbox) instead of a new-tab link. */
  onClick?: () => void;
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let revoked = false;
    let url: string | null = null;

    fetchProtectedObjectUrl(path)
      .then((next) => {
        // The component may have unmounted while the bytes were in flight.
        if (revoked) {
          URL.revokeObjectURL(next);
          return;
        }
        url = next;
        setObjectUrl(next);
      })
      .catch(() => setFailed(true));

    return () => {
      revoked = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path]);

  if (failed) {
    return (
      <div
        className={`flex items-center justify-center bg-rce-border/30 text-[10px] text-rce-soft ${className ?? ""}`}
        title={`Could not load ${alt}`}
      >
        unavailable
      </div>
    );
  }

  if (!objectUrl) {
    return <div className={`animate-pulse bg-rce-border/40 ${className ?? ""}`} aria-label={`Loading ${alt}`} />;
  }

  const image = <img src={objectUrl} alt={alt} className={className} onClick={onClick} />;
  if (onClick || !linkToFullSize) return image;

  return (
    <a href={objectUrl} target="_blank" rel="noreferrer">
      {image}
    </a>
  );
}
