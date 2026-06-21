// Test autonome de la logique de ticket (signature/verif HMAC), SANS Cloudflare.
// Tourne directement avec Node 26 (qui execute le TypeScript) :  node scripts/selftest.ts
// But : prouver que mint/verify marchent (bon secret, mauvais secret, altere, expire)
// avant meme d'avoir un compte/worker en ligne.

import { mintTicket, verifyTicket, type TicketPayload } from '../src/ticket.ts'

const secret = 'secret-de-test'
const base: TicketPayload = {
  prefix: 'relieo/users/abc123/randonnees/halsa/',
  role: 'public',
  session: 'sess-1',
  exp: Date.now() + 120_000,
}

let pass = 0
let fail = 0
const check = (label: string, ok: boolean): void => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} - ${label}`)
  if (ok) pass += 1
  else fail += 1
}

const token = await mintTicket(base, secret)
check('mint produit un jeton a 2 parties', token.split('.').length === 2)

const good = await verifyTicket(token, secret)
check('verify accepte un jeton valide', good !== null && good.prefix === base.prefix)

const wrongSecret = await verifyTicket(token, 'autre-secret')
check('verify rejette un mauvais secret', wrongSecret === null)

const tampered = token.slice(0, -3) + (token.endsWith('A') ? 'BBB' : 'AAA')
check('verify rejette un jeton altere', (await verifyTicket(tampered, secret)) === null)

const expired = await mintTicket({ ...base, exp: Date.now() - 1000 }, secret)
check('verify rejette un jeton expire', (await verifyTicket(expired, secret)) === null)

const otherCard = await verifyTicket(token, secret)
check(
  'le prefixe est bien transporte (controle de perimetre cote Worker)',
  otherCard?.prefix === base.prefix && !'relieo/users/zzz/'.startsWith(otherCard!.prefix),
)

console.log(`\n${pass} OK, ${fail} FAIL`)
if (fail > 0) process.exit(1)
