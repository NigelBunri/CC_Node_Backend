import { IsUUID, IsString, IsOptional } from 'class-validator';

export class SendMessageDto {
  @IsUUID() conversationId!: string;
  @IsString() ciphertext!: string; // server never sees plaintext
  @IsOptional() replyToId?: string;
}
