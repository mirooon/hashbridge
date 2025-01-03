import { QRCodeSVG } from 'qrcode.react';

export function QrCode({ value, size = 192 }: { value: string; size?: number }) {
  return (
    <div className="shrink-0 rounded-xl bg-white p-3">
      <QRCodeSVG value={value} size={size} />
    </div>
  );
}
