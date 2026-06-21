# Stockage R2 — modération IA

> Contrat de données des fichiers de modération dans R2. Ces fichiers sont écrits par le **videur**
> (Cloudflare Worker, binding R2) et lus à la fois par le videur (refus d'octet) et par les routes
> **Vercel** (console admin + filtrage à la lecture). Garder ce document en phase avec le code des
> deux côtés. Voir aussi `docs/PLAN-moderation-ia.md`.

## Rappel : où vivent les médias

Chaque média est stocké sous le préfixe de son propriétaire :

```
relieo/users/<uid>/randonnees/<folder>/media/<fingerprint>-<filename>      # original (photo ou vidéo)
relieo/users/<uid>/randonnees/<folder>/previews/<fingerprint>.jpg          # vignette (générée client)
```

- `<uid>` : uid Firebase du propriétaire. `<folder>` : code de carte normalisé (ex `halsa`).
- L'**identifiant de modération d'un média = sa clé R2 complète** (chaîne ci-dessus).
- On modère **l'original ET la vignette** comme deux objets indépendants : chacun porte son propre
  statut, chacun est bloqué selon son propre verdict (pas de lien preview↔original à maintenir).

### Extraire les infos d'une clé R2

| Info | Règle |
|---|---|
| `ownerUid` | segment juste après `users/` |
| `mapFolder` | segment juste après `randonnees/` |
| `mediaKind` | `video` si le `content-type` R2 commence par `video/`, sinon `image` (une vignette est toujours `image`) |

## Fichiers d'état (à la racine `relieo/`)

Même convention que l'existant (`relieo/sanctions.json`, `relieo/email-usage.json`,
`relieo/admin-notifications.json`) : un JSON par état, à la racine `relieo/`.

### 1. `relieo/media-scanned.json` — médias déjà passés par l'IA

```jsonc
{
  "ids": [
    "relieo/users/abc/randonnees/voyage/media/9f3a-photo.jpg",
    "relieo/users/abc/randonnees/voyage/previews/9f3a.jpg"
  ],
  "updatedAt": "2026-06-21T10:00:00.000Z"
}
```

- `ids` : **toutes** les clés déjà analysées, **quel que soit le verdict** (ok ou flaggé). Sert à ne
  **jamais re-scanner** (économie) et au videur pour savoir ce qui est « connu ».
- Le seed Halsa y inscrit les médias de Halsa **sans appel Sightengine** (pré-validés).
- **Écrit par** : le scan (videur). **Lu par** : le videur (`canServe`) + le scan (ce qui reste à faire).

### 2. `relieo/media-moderation.json` — médias flaggés / rejetés

```jsonc
{
  "items": [
    {
      "id": "relieo/users/abc/randonnees/voyage/media/9f3a-photo.jpg",
      "ownerUid": "abc",
      "mapFolder": "voyage",
      "mediaKind": "image",
      "status": "flagged",          // 'flagged' (en attente admin) | 'rejected' (supprimé)
      "aiCategory": "nudity",        // 'nudity' | 'gore' | 'offensive'
      "aiScore": 0.92,
      "scannedAt": "2026-06-21T10:00:00.000Z",
      "reviewedAt": null,
      "reviewedBy": null             // uid admin si revu
    }
  ],
  "updatedAt": "2026-06-21T10:00:00.000Z"
}
```

- Contient **uniquement** les flaggés/rejetés (sous-ensemble de `media-scanned.json`).
- `ownerEmail` et `mapCode` lisibles ne sont **pas** stockés ici (le videur n'a pas Firebase) : la
  console admin (Vercel) les résout à l'affichage.
- **Écrit par** : le scan (flag) + la console admin (approve/reject). **Lu par** : le videur (blocage)
  + la console admin (file de revue) + le filtrage à la lecture.
- Règle de service du videur (`canServe`) :
  - visiteur (`role: public`) → servable si `id ∈ media-scanned` **et** `id ∉ {flagged, rejected}`.
  - propriétaire/admin (`role: owner`) → servable sauf si `status === 'rejected'`.

### 3. `relieo/media-moderation-usage.json` — compteur d'opérations Sightengine

```jsonc
{
  "day": "2026-06-21",
  "dayOps": 137,
  "month": "2026-06",
  "monthOps": 1840,
  "updatedAt": "2026-06-21T10:00:00.000Z"
}
```

- 1 photo = 1 op ; 1 vidéo = nombre de frames analysées (lu dans la réponse Sightengine).
- Réinitialisation logique au changement de `day` / `month` (comparaison à l'écriture).
- Sert au **cap quotidien** (`MODERATION_DAILY_OP_CAP`, défaut ~480 < 500 gratuit) et à l'affichage
  dans l'onglet **Coûts** (jauge vs gratuit 500/jour, 2000/mois).
- **Écrit par** : le scan (à chaque média traité). **Lu par** : le scan (garde-fou) + la console admin.

### 4. `relieo/media-moderation-queue.json` — file prioritaire « publication »

```jsonc
{
  "ids": [
    "relieo/users/abc/randonnees/voyage/media/7c11-clip.mp4"
  ],
  "updatedAt": "2026-06-21T10:00:00.000Z"
}
```

- Médias non encore scannés d'une carte qu'un user vient de **publier** : à traiter **en priorité**,
  avant le balayage de fond des brouillons (cf. cap quotidien). Vidée au fur et à mesure du scan.
- **Écrit par** : l'endpoint signal de publication (videur, appelé par `api/hikes`) + le scan (retrait).
  **Lu par** : le scan (traite cette file d'abord).

### 5. `relieo/media-moderation-pending.json` — jobs vidéo en attente de callback

```jsonc
{
  "jobs": [
    {
      "mediaId": "med_1ML2wKmVgucuNPBN6xT33",   // identifiant Sightengine
      "mediaKey": "relieo/users/abc/randonnees/voyage/media/7c11-clip.mp4",
      "ownerUid": "abc",
      "mapFolder": "voyage",
      "submittedAt": "2026-06-21T10:00:00.000Z"
    }
  ],
  "updatedAt": "2026-06-21T10:00:00.000Z"
}
```

- La modération vidéo est **asynchrone** : on soumet la vidéo, Sightengine répond un `med_...` puis
  rappelle plus tard le callback (qui ne porte que le `med_...`). Ce fichier fait le lien
  `med_... → clé R2` pour que le callback sache quel média écrire.
- **Écrit par** : le scan (à la soumission). **Lu/vidé par** : l'endpoint callback (à la fin du job).
- Une vidéo en `pending` n'est **pas** encore dans `media-scanned.json` → elle reste masquée au
  public (fail-closed) jusqu'au verdict. À la réception du callback final : verdict écrit dans
  `media-scanned` (+ `media-moderation` si flaggée), `usage` incrémenté du nombre de frames, job retiré.

## Ordre de scan (rappel)

1. `media-moderation-queue.json` (demandes de publication) — **priorité**.
2. Balayage de fond : clés sous `relieo/users/.../media/` et `.../previews/` **absentes** de
   `media-scanned.json`, hors folders exemptés (`MODERATION_EXEMPT_FOLDERS`, ex `halsa`).

À chaque média : lire les octets (binding R2) → pousser à Sightengine → écrire le verdict
(`media-scanned` + éventuellement `media-moderation`) → incrémenter `media-moderation-usage`. On
s'arrête au cap quotidien ; le reste est repris au passage suivant (les médias non traités restent
masqués au public, fail-closed).

## Concurrence

Lecture-modification-écriture de ces JSON sans verrou : acceptable au volume de lancement (un seul
scan à la fois via le cron, écritures admin rares). Si le volume grossit, envisager un verrou léger
(objet `*.lock` avec TTL) ou un découpage par shard.
