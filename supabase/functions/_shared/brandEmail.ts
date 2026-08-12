// Branded transactional email shell — the parchment/brick look of the site,
// table-based so it renders in Gmail/Outlook. All user-supplied text MUST go
// through esc() before being interpolated into bodyHtml.

export function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function brandEmail({
  heading,
  bodyHtml,
  cta,
  footnote,
}: {
  heading: string;
  bodyHtml: string; // paragraphs; escape user text with esc()
  cta?: { label: string; url: string };
  footnote?: string;
}): string {
  const button = cta
    ? `<tr><td style="padding:8px 32px 0;">
        <a href="${cta.url}" style="display:inline-block;background:#BC4026;color:#ffffff;text-decoration:none;font-family:Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;padding:14px 28px;border-radius:8px;">${esc(cta.label)}</a>
      </td></tr>`
    : "";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#E9DFC9;margin:0;padding:32px 12px;font-family:Georgia,'Times New Roman',serif;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#F4EEDF;border:1px solid #D9CBB0;border-radius:12px;">
      <tr><td style="padding:28px 32px 0;">
        <div style="font-size:15px;letter-spacing:.12em;text-transform:uppercase;color:#BC4026;font-weight:700;">Prelogue Studio</div>
      </td></tr>
      <tr><td style="padding:18px 32px 0;">
        <h1 style="margin:0;font-size:24px;line-height:1.3;color:#2A2420;font-weight:700;">${esc(heading)}</h1>
      </td></tr>
      <tr><td style="padding:16px 32px 0;font-size:16px;line-height:1.62;color:#4A423B;">
        ${bodyHtml}
      </td></tr>
      ${button}
      <tr><td style="padding:24px 32px 28px;font-size:14px;line-height:1.6;color:#8A7F73;">
        <p style="margin:0;">— Will<br>Prelogue Studio</p>
      </td></tr>
    </table>
    <div style="max-width:560px;margin:16px auto 0;font-size:12px;color:#8A7F73;font-family:Helvetica,Arial,sans-serif;">
      ${esc(footnote ?? "You're receiving this because of activity on your prelogue.studio account.")}
    </div>
  </td></tr>
</table>`;
}
