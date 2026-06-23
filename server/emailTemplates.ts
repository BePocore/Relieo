// Templates HTML des emails Relieo. Volontairement simples (styles inline, tables)
// pour une compatibilité large des clients mail, sans dépendance.

const BRAND = '#0f766e'
const INK = '#0f1623'
const MUTED = '#5a6b62'

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const layout = (title: string, bodyHtml: string): string => `<!doctype html>
<html lang="fr">
  <body style="margin:0;background:#f4f6f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${INK};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f5;padding:24px 0;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(15,22,35,0.08);">
          <tr><td style="background:${BRAND};padding:20px 28px;">
            <span style="color:#ffffff;font-size:18px;font-weight:800;letter-spacing:0.2px;">Relieo</span>
          </td></tr>
          <tr><td style="padding:28px;">
            <h1 style="margin:0 0 14px;font-size:19px;color:${INK};">${title}</h1>
            ${bodyHtml}
          </td></tr>
          <tr><td style="padding:18px 28px;border-top:1px solid #eceeed;">
            <p style="margin:0;font-size:12px;color:${MUTED};">Relieo, vos cartes interactives 3D en relief.</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`

const button = (href: string, label: string): string =>
  `<a href="${href}" style="display:inline-block;padding:12px 22px;border-radius:999px;background:${BRAND};color:#ffffff;font-weight:700;text-decoration:none;">${label}</a>`

const paragraph = (text: string): string =>
  `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:${INK};">${text}</p>`

const muted = (text: string): string =>
  `<p style="margin:14px 0 0;font-size:12.5px;line-height:1.5;color:${MUTED};">${text}</p>`

// Le lien vient de Firebase (généré par l'Admin SDK), c'est une URL sûre.
export const verificationEmailHtml = (link: string): string =>
  layout(
    'Confirmez votre adresse',
    [
      paragraph(
        'Bienvenue sur Relieo. Pour activer votre compte et commencer à créer vos cartes 3D, confirmez votre adresse e-mail :',
      ),
      `<p style="margin:18px 0;">${button(link, 'Confirmer mon adresse')}</p>`,
      muted(
        'Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :<br />' +
          `<a href="${link}" style="color:${BRAND};word-break:break-all;">${link}</a>`,
      ),
      muted(
        "Si vous n'êtes pas à l'origine de cette inscription, ignorez simplement ce message.",
      ),
    ].join(''),
  )

// Email de modération (message transmis au propriétaire). `message` et `mapTitle`
// viennent d'humains : on les échappe.
export const moderationEmailHtml = (
  heading: string,
  message: string,
  mapTitle?: string,
): string =>
  layout(
    heading,
    [
      mapTitle
        ? paragraph(`Carte concernée : <strong>${escapeHtml(mapTitle)}</strong>`)
        : '',
      paragraph("Message de l'équipe Relieo :"),
      `<blockquote style="margin:0 0 14px;padding:12px 16px;border-left:3px solid ${BRAND};background:#f4f6f5;border-radius:8px;font-size:14.5px;line-height:1.55;color:${INK};">${escapeHtml(message)}</blockquote>`,
      muted('Vous retrouvez aussi ce message dans vos notifications sur Relieo.'),
    ].join(''),
  )

export const adminAlertEmailHtml = (
  heading: string,
  message: string,
  actionUrl: string,
  actionLabel: string,
): string =>
  layout(
    heading,
    [
      paragraph(escapeHtml(message)),
      `<p style="margin:18px 0;">${button(actionUrl, actionLabel)}</p>`,
      muted('Cette alerte est aussi disponible dans la console admin Relieo.'),
    ].join(''),
  )
