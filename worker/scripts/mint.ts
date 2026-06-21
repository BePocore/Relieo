// Fabrique un ticket de test signe, pour valider le videur a la main.
//   node scripts/mint.ts <secret> <prefix> [role]
// Affiche le jeton sur stdout (a passer en en-tete X-Media-Ticket).
import { mintTicket, type TicketRole } from '../src/ticket.ts'

const [, , secret, prefix, role = 'public'] = process.argv
if (!secret || !prefix) {
  console.error('usage: node scripts/mint.ts <secret> <prefix> [role]')
  process.exit(1)
}

const token = await mintTicket(
  { prefix, role: role as TicketRole, session: 'cli-test', exp: Date.now() + 120_000 },
  secret,
)
process.stdout.write(token)
