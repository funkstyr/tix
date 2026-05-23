import { type JSX, useEffect, useRef, useState } from "react";

export type CountdownProps = {
  expiresAt: Date;
  onExpire?: () => void;
};

export function Countdown({ expiresAt, onExpire }: CountdownProps): JSX.Element {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const remainingMs = Math.max(0, expiresAt.getTime() - now);

  // Hold the latest onExpire in a ref so the firing effect doesn't depend on
  // its identity — parents can pass an inline function without re-arming.
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  const firedRef = useRef(false);

  useEffect(() => {
    if (remainingMs === 0 && !firedRef.current) {
      firedRef.current = true;
      onExpireRef.current?.();
    }
  }, [remainingMs]);

  return <span>{formatRemaining(remainingMs)}</span>;
}

function formatRemaining(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");

  return `${minutes}:${seconds}`;
}
