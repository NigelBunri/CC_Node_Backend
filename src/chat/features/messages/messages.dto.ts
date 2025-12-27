// src/chat/features/messages/messages.dto.ts

import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
  ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { MessageKind } from '../../chat.types';

export class AttachmentDto {
  @IsString() id!: string;
  @IsString() url!: string;

  @IsString() originalName!: string;
  @IsString() mimeType!: string;

  @IsInt() @Min(0) size!: number;

  @IsOptional() @IsString() kind?: string;

  @IsOptional() @IsInt() @Min(0) width?: number;
  @IsOptional() @IsInt() @Min(0) height?: number;
  @IsOptional() @IsInt() @Min(0) durationMs?: number;
  @IsOptional() @IsString() thumbUrl?: string;
}

export class StyledTextDto {
  @IsString() text!: string;

  @IsString() backgroundColor!: string;

  @IsInt() @Min(10) @Max(120)
  fontSize!: number;

  @IsString() fontColor!: string;

  @IsOptional() @IsString()
  fontFamily?: string;
}

export class VoiceDto {
  @IsInt() @Min(1) @Max(60 * 60 * 1000)
  durationMs!: number;
}

export class StickerDto {
  @IsString() id!: string;
  @IsString() uri!: string;

  @IsOptional() @IsString() text?: string;
  @IsOptional() @IsInt() @Min(0) width?: number;
  @IsOptional() @IsInt() @Min(0) height?: number;
}

export class ContactDto {
  @IsString() id!: string;
  @IsString() name!: string;
  @IsString() phone!: string;
}

export class PollOptionDto {
  @IsString() id!: string;
  @IsString() text!: string;

  @IsOptional() @IsInt() @Min(0)
  votes?: number;
}

export class PollDto {
  @IsOptional() @IsString()
  id?: string;

  @IsString() question!: string;

  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => PollOptionDto)
  options!: PollOptionDto[];

  @IsOptional() @IsBoolean()
  allowMultiple?: boolean;

  @IsOptional() @IsString()
  expiresAt?: string | null;
}

export class EventDto {
  @IsOptional() @IsString()
  id?: string;

  @IsString() title!: string;

  @IsOptional() @IsString()
  description?: string;

  @IsOptional() @IsString()
  location?: string;

  @IsString() startsAt!: string;

  @IsOptional() @IsString()
  endsAt?: string;
}

export class SendMessageDto {
  @IsString() conversationId!: string;
  @IsString() clientId!: string;

  @IsIn([
    'text',
    'voice',
    'styled_text',
    'sticker',
    'system',
    'contacts',
    'poll',
    'event',
  ] satisfies MessageKind[])
  kind!: MessageKind;

  // Plain text
  @IsOptional() @IsString()
  text?: string;

  // Styled text
  @IsOptional()
  @ValidateNested()
  @Type(() => StyledTextDto)
  styledText?: StyledTextDto;

  // Voice metadata
  @IsOptional()
  @ValidateNested()
  @Type(() => VoiceDto)
  voice?: VoiceDto;

  // Sticker payload
  @IsOptional()
  @ValidateNested()
  @Type(() => StickerDto)
  sticker?: StickerDto;

  // Attachments
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => AttachmentDto)
  attachments?: AttachmentDto[];

  // Contacts
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ContactDto)
  contacts?: ContactDto[];

  // Poll
  @IsOptional()
  @ValidateNested()
  @Type(() => PollDto)
  poll?: PollDto;

  // Event
  @IsOptional()
  @ValidateNested()
  @Type(() => EventDto)
  event?: EventDto;

  @IsOptional() @IsString()
  replyToId?: string;
}
