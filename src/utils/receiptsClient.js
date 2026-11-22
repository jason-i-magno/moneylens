// Browser side of the HSA receipt vault: calls the local receipts API (server/receiptsApi.js).

import { localApiRequest } from './localApi';

const NO_SERVER = "Receipts are kept by MoneyLens's local server. Open the app through it (npm run dev, or the address it serves) to use the vault.";

export const receiptsRequest = (action, body = {}) => localApiRequest(`/api/receipts/${action}`, body, NO_SERVER);

// What the vault takes, as the server checks it
export const RECEIPT_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,application/pdf';
export const RECEIPT_MAX_BYTES = 15 * 1024 * 1024;

// A File as base64, without the data: prefix
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// A stored receipt file as an object URL for <img> or <iframe>; the caller revokes it
export async function receiptFileUrl(fileId) {
  const { mime, data } = await receiptsRequest('file', { fileId });
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  return { url: URL.createObjectURL(new Blob([bytes], { type: mime })), mime };
}
