# Conditions Générales d'Utilisation de Relieo

> **Avertissement (à retirer avant publication).** Ce document est un premier jet rédigé pour être
> honnête et complet, mais il n'a pas valeur de conseil juridique. Il doit être relu par un
> professionnel du droit avant mise en ligne. Les mentions `[À COMPLÉTER]` doivent être renseignées
> avec des informations exactes : toute information fausse dans des CGU peut se retourner contre
> l'éditeur.

**Dernière mise à jour : [À COMPLÉTER : date]**
**Version : 1.0 (brouillon)**

---

## 1. Qui nous sommes

Relieo (« le Service », « nous ») est une application web permettant de créer des cartes interactives
en relief 3D sur lesquelles les utilisateurs placent des photos, vidéos et traces GPS, et de les
partager.

- **Éditeur du Service :** [À COMPLÉTER : nom de l'éditeur, personne physique ou société]
- **Statut juridique / immatriculation :** [À COMPLÉTER : ex. micro-entreprise, SIRET, ou « particulier »]
- **Adresse :** [À COMPLÉTER]
- **Contact :** [À COMPLÉTER : adresse email de contact]
- **Directeur de la publication :** [À COMPLÉTER]
- **Hébergement du site :** Vercel Inc. (déploiement de l'application)
- **Site :** https://relieo.fr

> Honnêteté : à ce jour, Relieo est un projet personnel en développement. Nous l'indiquons clairement
> plutôt que de laisser croire à une structure plus importante. Le niveau de service, de disponibilité
> et de support correspond à celui d'un projet en phase de lancement.

---

## 2. Acceptation des conditions

En créant un compte ou en utilisant le Service, vous acceptez les présentes CGU. Si vous n'êtes pas
d'accord avec l'une de ces clauses, n'utilisez pas le Service.

Lors de l'inscription, il vous est demandé d'accepter explicitement ces CGU. Cette acceptation est
enregistrée (date et identifiant de compte). Tant que vous ne les avez pas acceptées, l'accès aux
fonctionnalités est bloqué.

---

## 3. Éligibilité et âge

Vous devez avoir au moins **[À COMPLÉTER : 15 ans (seuil RGPD français pour le consentement) ou 18 ans]**
pour utiliser le Service. Si vous êtes mineur, vous déclarez avoir l'autorisation de votre représentant
légal.

> Honnêteté : nous ne vérifions pas activement votre âge. Cette clause fixe une règle, elle ne constitue
> pas un contrôle technique.

---

## 4. Votre compte

- Vous créez un compte avec une adresse email (et un mot de passe) ou via un fournisseur tiers (Google).
- L'authentification est gérée par **Firebase Authentication (Google LLC)**.
- Vous êtes responsable de la confidentialité de vos identifiants et des actions effectuées depuis
  votre compte.
- Une **vérification de votre adresse email est obligatoire** : tant qu'elle n'est pas validée, l'accès
  aux fonctionnalités est restreint.
- Vous pouvez à tout moment demander la suppression de votre compte (voir section 12).

---

## 5. Votre contenu

« Votre contenu » désigne les photos, vidéos, traces GPS, titres, descriptions, nom d'affichage, photo
de profil et tout autre élément que vous importez ou créez sur le Service.

- **Vous restez propriétaire de votre contenu.** Nous ne revendiquons aucun droit de propriété dessus.
- **Vous nous accordez une licence limitée** strictement nécessaire au fonctionnement du Service :
  héberger, stocker, redimensionner (génération de vignettes), afficher et transmettre votre contenu
  pour vous le restituer et, lorsque vous le décidez, le rendre accessible aux personnes à qui vous le
  partagez ou au public. Cette licence est non exclusive, sans rémunération, et prend fin lorsque vous
  supprimez le contenu ou votre compte (sous réserve des délais techniques de suppression et des
  obligations légales de conservation).
- **Nous ne vendons pas votre contenu, ne l'exploitons pas à des fins publicitaires, et ne l'utilisons
  pas pour entraîner des modèles d'intelligence artificielle.**
- **Vous êtes responsable de votre contenu** : vous garantissez détenir les droits nécessaires
  (notamment le droit à l'image des personnes visibles, les droits d'auteur des médias) et que votre
  contenu respecte la loi et les présentes CGU.

---

## 6. Visibilité de votre contenu — ce qu'il faut vraiment savoir

C'est un point que nous tenons à expliquer sans détour.

Le Service propose plusieurs niveaux de visibilité pour une carte :
- **Brouillon** : carte en cours de création.
- **Partagée par code / lien** : accessible à toute personne disposant du lien.
- **Publique** : visible par tous (fonctionnalité [à venir / en cours de déploiement]).

**Limite technique importante et honnête :** vos fichiers (photos, vidéos) sont stockés sur un service
de stockage (Cloudflare R2) à des adresses (URL) **non devinables mais non protégées par un contrôle
d'accès individuel**. Concrètement :

- Une carte en « brouillon » ou « partagée par code » **n'est pas chiffrée ni totalement privée** au
  niveau des fichiers : **toute personne qui connaît l'URL exacte d'un de vos médias peut y accéder**,
  même sans compte.
- La confidentialité repose donc sur le caractère secret du lien, pas sur une barrière technique
  infranchissable.

**Conséquence pratique : ne mettez pas sur le Service des médias que vous considérez comme strictement
confidentiels ou sensibles.** Si vous partagez un lien, considérez que les fichiers qu'il contient
peuvent être consultés par toute personne à qui ce lien serait transmis.

Nous travaillons à renforcer ce point, mais nous préférons vous le dire clairement aujourd'hui plutôt
que de laisser croire à une sécurité que nous n'offrons pas encore.

---

## 7. Modération automatisée par intelligence artificielle

Pour permettre une diffusion publique sûre, **les médias (photos et vidéos) font l'objet d'une analyse
automatisée par un prestataire d'intelligence artificielle de modération.**

- **Prestataire utilisé :** Sightengine (société française, données traitées dans l'Union européenne).
- **Finalité :** détecter les contenus interdits (nudité, contenu sexuel, violence/contenu sanglant,
  gestes ou symboles inappropriés, etc.) avant et pendant leur diffusion.
- **Ce qui est analysé :** vos fichiers médias (le fichier d'origine, et la vignette de prévisualisation).
- **Comment :** le prestataire récupère le fichier via son URL pour l'analyser. Selon ses conditions,
  **les fichiers ne sont pas conservés durablement par le prestataire et sont supprimés après
  traitement**, ne sont pas partagés avec des tiers et ne servent pas à entraîner ses modèles.
- **En acceptant les présentes CGU, vous consentez explicitement à cette analyse automatisée de vos
  médias par ce prestataire.** Cette analyse est une condition nécessaire pour publier des contenus
  accessibles à d'autres personnes.

**Décision humaine.** L'IA ne décide pas seule de sanctions définitives. Lorsqu'un média est signalé par
l'IA :
- il est **masqué de la diffusion publique** en attendant une vérification ;
- un administrateur examine le signalement et prend la décision finale (rétablir le média, ou le
  supprimer s'il est non conforme).

Si un de vos médias est supprimé pour non-conformité, vous en êtes informé (notification dans
l'application et/ou par email), avec le motif.

> Honnêteté : aucun système de modération, humain ou automatique, n'est parfait. Des erreurs (faux
> positifs ou faux négatifs) restent possibles. Nous réglons les seuils de manière prudente, ce qui peut
> conduire à masquer temporairement des contenus parfaitement légitimes le temps d'une vérification.

---

## 8. Contenus et comportements interdits

Il est interdit de publier ou de diffuser via le Service, notamment :
- des contenus à caractère sexuel, pornographique, ou de la nudité non sollicitée ;
- des contenus pédopornographiques (signalés aux autorités compétentes le cas échéant) ;
- des contenus violents, haineux, incitant à la haine, à la discrimination ou au terrorisme ;
- des contenus dont vous ne détenez pas les droits (violation de droit d'auteur ou du droit à l'image) ;
- des données personnelles de tiers sans leur consentement ;
- des contenus trompeurs, frauduleux, ou des logiciels malveillants ;
- tout usage visant à contourner les mécanismes de quota, de sécurité ou de modération.

---

## 9. Modération, sanctions et recours

Nous pouvons, en cas de non-respect des CGU :
- **dépublier** une carte (elle repasse en privé, son contenu n'est pas supprimé) ;
- **supprimer** un média ou une carte ;
- **bloquer** un compte (avec un message expliquant le motif) ;
- **supprimer** un compte en cas de manquements répétés (à partir de [À COMPLÉTER : 3] blocages).

Chaque action de modération vous est communiquée avec un motif. **Vous disposez d'un droit de contestation
(appel)** : un message d'appel peut être envoyé à l'administrateur, qui peut y répondre. Cette possibilité
ne garantit pas le rétablissement du compte ou du contenu.

> Honnêteté sur l'accès administrateur : pour assurer la modération et le support technique, un
> administrateur du Service dispose d'un accès étendu lui permettant de **consulter et, si nécessaire,
> d'éditer ou de supprimer les cartes et médias hébergés**, y compris non publics. La propriété de votre
> contenu vous reste attribuée. Cet accès est utilisé pour le fonctionnement, la sécurité et la
> modération du Service, jamais pour une exploitation commerciale de votre contenu.

---

## 10. Forfaits, stockage et prix

- Un forfait gratuit est proposé, incluant un quota de stockage de **[À COMPLÉTER : 5] Go par compte**.
- Des forfaits payants peuvent être proposés à l'avenir ; leurs conditions et prix seront communiqués
  avant toute souscription.
- Le quota correspond au volume total de vos fichiers. Au-delà, l'ajout de nouveaux médias peut être
  bloqué.

> Honnêteté : à ce jour, les forfaits payants ne sont pas commercialisés ; tout compte est en forfait
> gratuit. Aucun paiement ne vous est demandé.

---

## 11. Vos données personnelles (RGPD)

Cette section résume le traitement de vos données. Une politique de confidentialité détaillée
[à compléter / à publier] précisera l'ensemble.

### 11.1 Responsable de traitement
[À COMPLÉTER : éditeur de Relieo], joignable à [À COMPLÉTER : email].

### 11.2 Données traitées
- **Compte :** adresse email, nom d'affichage, photo de profil, identifiant de compte, mot de passe
  (géré et stocké de manière sécurisée par Firebase, nous n'y avons pas accès en clair).
- **Contenu :** vos médias, traces GPS (qui peuvent révéler des lieux que vous avez fréquentés),
  titres, descriptions.
- **Techniques :** données de connexion et journaux nécessaires au fonctionnement et à la sécurité,
  consommation de stockage, état de modération de votre compte.

### 11.3 Finalités et bases légales
- Fournir le Service (exécution du contrat : les présentes CGU).
- Modérer les contenus diffusables (intérêt légitime + votre consentement pour l'analyse IA).
- Sécurité, prévention des abus (intérêt légitime).
- Communications liées au compte et à la modération (exécution du contrat).

### 11.4 Sous-traitants et destinataires
Nous faisons appel à des prestataires techniques (« sous-traitants ») pour fournir le Service. Au mieux
de notre connaissance :

| Prestataire | Rôle | Localisation des données |
|---|---|---|
| Cloudflare (R2) | Stockage des médias | [À COMPLÉTER : région du bucket ; vérifier UE] |
| Google (Firebase) | Authentification, base de profils | Peut impliquer des transferts hors UE |
| Vercel | Hébergement de l'application | Peut impliquer des transferts hors UE (États-Unis) |
| Resend | Envoi des emails transactionnels | Peut impliquer des transferts hors UE (États-Unis) |
| Sightengine | Modération IA des médias | Union européenne |

> Honnêteté sur les transferts : certains de ces prestataires sont des sociétés américaines, ce qui peut
> entraîner un transfert de données hors de l'Union européenne. De tels transferts sont en principe
> encadrés par des garanties appropriées (clauses contractuelles types, dispositifs de conformité du
> prestataire). Nous indiquons ce point ouvertement ; les détails seront précisés dans la politique de
> confidentialité. `[À VÉRIFIER ET COMPLÉTER avec les engagements réels de chaque prestataire.]`

Nous ne vendons ni ne louons vos données personnelles à des tiers.

### 11.5 Durée de conservation
- Données de compte et contenu : conservés tant que votre compte est actif.
- Après suppression : votre contenu est supprimé du stockage. Selon le cas, certaines informations
  minimales peuvent être conservées (par exemple pour empêcher la réinscription d'un compte sanctionné,
  ou pour respecter une obligation légale). `[À COMPLÉTER : durées précises]`
- Les fichiers transmis au prestataire de modération sont, selon ses conditions, supprimés après
  traitement.

### 11.6 Vos droits
Conformément au RGPD, vous disposez des droits d'accès, de rectification, d'effacement, de limitation,
d'opposition et de portabilité. Vous pouvez les exercer en nous contactant à [À COMPLÉTER : email].
Vous pouvez aussi introduire une réclamation auprès de la CNIL (www.cnil.fr).

> Honnêteté : l'analyse automatisée par IA décrite en section 7 est nécessaire à la diffusion publique
> de contenus. Si vous vous opposez à cette analyse, vous pouvez ne pas publier de médias destinés à
> être vus par d'autres ; le reste du Service demeure utilisable dans la limite des fonctionnalités
> concernées.

---

## 12. Suppression de votre compte

Vous pouvez demander la suppression de votre compte depuis votre profil. Selon le cas :
- vos cartes et médias sont supprimés du stockage ;
- votre adresse email peut être libérée (réinscription possible) ou, en cas de suppression liée à une
  sanction, conservée pour empêcher la réinscription.

Un délai technique de suppression effective peut s'appliquer.

---

## 13. Disponibilité et responsabilité

- Le Service est fourni « en l'état », sans garantie de disponibilité continue. Étant en développement,
  des interruptions, bugs ou pertes de données sont possibles.
- **Faites vos propres sauvegardes des contenus importants.** Nous ne pouvons garantir l'absence de
  perte de données.
- Dans les limites permises par la loi, notre responsabilité ne saurait être engagée pour les dommages
  indirects. Aucune clause ne vise à exclure une responsabilité qui ne peut légalement l'être
  (notamment en cas de faute lourde ou d'atteinte aux droits des consommateurs).

---

## 14. Modification des CGU

Nous pouvons faire évoluer ces CGU. En cas de modification importante, nous vous en informerons (par
exemple à la connexion ou par email) et, le cas échéant, vous demanderons d'accepter à nouveau les
conditions. La date de dernière mise à jour figure en tête de document.

---

## 15. Droit applicable et litiges

Les présentes CGU sont régies par le **droit français**. En cas de litige, et après tentative de
résolution amiable, les tribunaux compétents seront ceux désignés par les règles de droit applicables.
En tant que consommateur, vous bénéficiez également des dispositions protectrices de votre pays de
résidence et pouvez recourir à une médiation de la consommation. `[À COMPLÉTER : médiateur de la
consommation si applicable.]`

---

## 16. Contact

Pour toute question relative à ces CGU ou à vos données : [À COMPLÉTER : email de contact].
