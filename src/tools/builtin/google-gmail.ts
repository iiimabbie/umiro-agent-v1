import { google } from "googleapis";
import { getAuthClient } from "../../google/auth.js";
import type { Tool } from "../../types.js";

function getGmail() {
  const auth = getAuthClient();
  if (!auth) throw new Error("Google API 未授權，請先用 /google-auth 授權");
  return google.gmail({ version: "v1", auth });
}

function decodeBody(body: { data?: string | null }): string {
  if (!body.data) return "";
  return Buffer.from(body.data, "base64url").toString("utf-8");
}

function extractBody(payload: { mimeType?: string | null; body?: { data?: string | null }; parts?: Array<{ mimeType?: string | null; body?: { data?: string | null }; parts?: unknown[] }> }): string {
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBody(payload.body);
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return decodeBody(part.body);
      }
    }
    for (const part of payload.parts) {
      const result = extractBody(part as typeof payload);
      if (result) return result;
    }
  }
  if (payload.body?.data) return decodeBody(payload.body);
  return "";
}

type MessageHeader = { name?: string | null; value?: string | null };

function headerValue(headers: MessageHeader[], name: string): string {
  const found = headers.find(h => h.name?.toLowerCase() === name.toLowerCase());
  return found?.value?.trim() || "";
}

function headerValues(headers: MessageHeader[], name: string): string[] {
  return headers
    .filter(h => h.name?.toLowerCase() === name.toLowerCase())
    .map(h => h.value?.trim() || "")
    .filter(v => v.length > 0);
}

function extractAddress(value: string): string {
  const angle = value.match(/<([^>]+)>/);
  return (angle ? angle[1] : value).trim().toLowerCase();
}

/**
 * Recipients actually reachable for this message, including forwarding hops.
 * Mail forwarded from another account keeps the original To while Delivered-To
 * records the mailbox it landed in, so both are needed to tell them apart.
 */
export function collectRecipients(headers: MessageHeader[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of ["To", "Delivered-To", "X-Forwarded-To"]) {
    for (const raw of headerValues(headers, name)) {
      for (const part of raw.split(",")) {
        const value = part.trim();
        if (!value) continue;
        const key = extractAddress(value);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(value);
      }
    }
  }
  return out;
}

export function formatSearchLine(id: string, headers: MessageHeader[]): string {
  const subject = headerValue(headers, "Subject") || "(no subject)";
  const from = headerValue(headers, "From") || "?";
  const date = headerValue(headers, "Date") || "?";
  const recipients = collectRecipients(headers);
  const to = recipients.length > 0 ? recipients.join(", ") : "?";
  return `[${id}] ${date} | ${from} -> ${to} | ${subject}`;
}

export function formatMessageHeaderBlock(headers: MessageHeader[]): string {
  const lines = [
    `From: ${headerValue(headers, "From") || "?"}`,
    `To: ${collectRecipients(headers).join(", ") || "?"}`,
  ];
  const cc = headerValue(headers, "Cc");
  if (cc) lines.push(`Cc: ${cc}`);
  lines.push(`Date: ${headerValue(headers, "Date") || "?"}`);
  lines.push(`Subject: ${headerValue(headers, "Subject") || "(no subject)"}`);
  return lines.join("\n");
}

export const gmailSearch: Tool = {
  name: "google_gmail_search",
  description: "Search Gmail messages. Each result shows date, sender, the recipient addresses the message was actually delivered to (including forwarding hops), and subject, so mail forwarded from several mailboxes can be told apart.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Gmail search query (same syntax as Gmail search bar)" },
      max_results: { type: "number", description: "Max messages to return (default: 10)" },
    },
    required: ["query"],
  },
  execute: async (args) => {
    const { query, max_results } = args as { query: string; max_results?: number };
    const gmail = getGmail();
    const list = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: max_results || 10,
    });
    const messages = list.data.messages || [];
    if (messages.length === 0) return "No messages found.";

    const results: string[] = [];
    for (const msg of messages) {
      const detail = await gmail.users.messages.get({
        userId: "me",
        id: msg.id!,
        format: "metadata",
        metadataHeaders: ["Subject", "From", "Date", "To", "Delivered-To", "X-Forwarded-To"],
      });
      const headers = detail.data.payload?.headers || [];
      results.push(formatSearchLine(msg.id!, headers));
    }
    return results.join("\n");
  },
};

export const gmailRead: Tool = {
  name: "google_gmail_read",
  description: "Read a specific Gmail message by ID. Returns sender, recipient addresses (including forwarding hops), date, subject and the full text body.",
  parameters: {
    type: "object",
    properties: {
      message_id: { type: "string", description: "Message ID" },
    },
    required: ["message_id"],
  },
  execute: async (args) => {
    const { message_id } = args as { message_id: string };
    const gmail = getGmail();
    const res = await gmail.users.messages.get({ userId: "me", id: message_id, format: "full" });
    const headers = res.data.payload?.headers || [];
    const body = extractBody(res.data.payload as Parameters<typeof extractBody>[0]);
    return `${formatMessageHeaderBlock(headers)}\n\n${body}`;
  },
};

export const gmailSend: Tool = {
  name: "google_gmail_send",
  description: "Send an email immediately. IRREVERSIBLE — it reaches real recipients and cannot be recalled. Confirm recipient, subject, and body with the owner before calling; if there is any doubt, use google_gmail_create_draft instead and let the owner send it.",
  parameters: {
    type: "object",
    properties: {
      to: { type: "string", description: "Recipient email address" },
      subject: { type: "string", description: "Email subject" },
      body: { type: "string", description: "Email body (plain text)" },
    },
    required: ["to", "subject", "body"],
  },
  execute: async (args) => {
    const { to, subject, body } = args as { to: string; subject: string; body: string };
    const gmail = getGmail();
    const raw = Buffer.from(
      `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
    ).toString("base64url");
    const res = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
    return `Email sent (${res.data.id})`;
  },
};

export const gmailCreateDraft: Tool = {
  name: "google_gmail_create_draft",
  description: "Create an email draft in Gmail without sending it. Safe alternative to google_gmail_send when the owner should review the wording first.",
  parameters: {
    type: "object",
    properties: {
      to: { type: "string", description: "Recipient email address" },
      subject: { type: "string", description: "Email subject" },
      body: { type: "string", description: "Email body (plain text)" },
    },
    required: ["to", "subject", "body"],
  },
  execute: async (args) => {
    const { to, subject, body } = args as { to: string; subject: string; body: string };
    const gmail = getGmail();
    const raw = Buffer.from(
      `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
    ).toString("base64url");
    const res = await gmail.users.drafts.create({ userId: "me", requestBody: { message: { raw } } });
    return `Draft created (${res.data.id})`;
  },
};
