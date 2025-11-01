// src/messages/dto/send-message.dto.ts
export class AttachmentDto {
  id: string;       // key/filename
  url: string;      // public URL (local or S3)
  name: string;     // original file name
  mime: string;     // content-type
  size: number;     // bytes
  width?: number;   // future: images/videos
  height?: number;
  duration?: number;// future: audio/video
  thumbUrl?: string;// future
}

export class SendMessageDto {
  conversationId: string;
  ciphertext?: string;       // optional if sending file-only message
  replyToId?: string;
  attachments?: AttachmentDto[];
}
