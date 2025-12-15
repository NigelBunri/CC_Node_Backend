// src/messages/dto/send-message.dto.ts

// Keep in sync with AttachmentWireMeta in chat.gateway.ts
export type AttachmentKind = 'image' | 'video' | 'audio' | 'document' | 'other';

export class AttachmentDto {
  id: string;          // key/filename
  url: string;         // public URL (local or S3)
  originalName: string; // original file name
  mimeType: string;     // content-type
  size: number;         // bytes

  kind?: AttachmentKind | string;

  width?: number;       // images/videos
  height?: number;
  durationMs?: number;  // audio/video duration (ms)
  thumbUrl?: string;    // optional thumbnail
}

/* ---------------------- Rich content sub-DTOs ---------------------- */

export class VoiceDto {
  uri: string;
  durationMs: number;
  waveform?: number[];
}

export class StyledTextDto {
  text: string;
  backgroundColor: string;
  fontSize: number;
  fontColor: string;
  fontFamily?: string | null;
}

export class StickerDto {
  id: string;
  uri: string;
  text?: string;
  width?: number;
  height?: number;
}

export class ContactDto {
  id: string;
  name: string;
  phone: string;
}

/* -------------------------- Main DTO -------------------------- */

export class SendMessageDto {
  conversationId: string;

  // text content (optional if file-only or rich-only)
  ciphertext?: string;

  replyToId?: string | null;

  attachments?: AttachmentDto[];

  // 🔹 Rich content fields (must match what you use in chat.gateway.ts)
  kind?:
    | 'text'
    | 'voice'
    | 'styled_text'
    | 'sticker'
    | 'contacts'
    | 'poll'
    | 'event'
    | 'system';

  voice?: VoiceDto | null;

  styledText?: StyledTextDto | null;

  sticker?: StickerDto | null;

  // 🔹 Additional rich payloads
  contacts?: ContactDto[];
  poll?: any;
  event?: any;

  // 🔹 Extra metadata (used for dedupe/ACK correlation + UI)
  clientId?: string;              // IMPORTANT for your unique index
  senderName?: string | null;     // optional, used for UI / broadcast
}
