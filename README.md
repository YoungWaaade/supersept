# Supersept

Une interface locale façon [Superset](https://superset.sh) pour faire tourner plusieurs sessions **Claude Code** en parallèle, les ranger par projet et garder une mémoire par projet. Tout tourne sur ta machine : rien n'est hébergé, rien n'est envoyé ailleurs que ce que Claude Code envoie déjà.

- **Sessions par projet** : chaque « espace de travail » est un Claude Code dans un vrai terminal, dans ton dossier ou dans un **git worktree isolé** (nouvelle branche).
- **Statuts en direct** : en cours, attend ta réponse, à revoir. Notifications du navigateur quand un agent a fini.
- **Mémoire par projet** : un fichier markdown injecté au lancement de chaque agent, que Claude met à jour lui-même.
- **Reprise** : les conversations se reprennent après un redémarrage, et tes anciennes sessions Claude Code sont listées dans « Historique ».
- **Panneau de droite** : fichiers, modifications git (diff), statut de la PR, commande d'exécution du projet (`npm run dev`…).

## Prérequis

- macOS
- [Node.js](https://nodejs.org) **22.13 ou plus récent** (`node -v`)
- [Claude Code](https://code.claude.com) installé et connecté : la commande `claude` doit marcher dans ton terminal
- git
- Optionnel : [GitHub CLI](https://cli.github.com) (`gh auth login`), pour lier des issues ou PR et voir le statut des PR

## Installation

```bash
git clone https://github.com/YoungWaaade/supersept.git
cd supersept
npm install
npm run service
```

`npm run service` compile l'interface et installe Supersept comme service macOS : il démarre tout seul à l'ouverture de session et redémarre s'il plante.

Ouvre ensuite **http://supersept.localhost:4317** (ou http://localhost:4317 si ton navigateur ne gère pas les adresses `.localhost`).

Astuce : pour l'avoir dans le Dock comme une app, utilise Chrome (menu ⋮ → Caster, enregistrer et partager → Installer la page en tant qu'application) ou Safari (Fichier → Ajouter au Dock).

### Sans service en arrière-plan

```bash
npm start
```

Supersept tourne tant que le terminal reste ouvert.

## Utilisation

1. **Ajoute un projet** : bouton dossier à côté de « PROJETS » dans la sidebar.
   - **Ouvrir un dossier** existant (Supersept propose aussi ceux où tu as déjà utilisé Claude Code) ;
   - **Cloner depuis GitHub** : choisis un de tes repos (ou colle son URL), il est cloné dans `~/claude sessions/<repo>` et devient un projet (nécessite `gh`) ;
   - **Nouveau projet vide** dans `~/claude sessions/`, que tu pourras relier à GitHub plus tard (clic droit sur le projet → Relier à un repo GitHub).
2. **Nouvel espace de travail** (⌘N) : décris la tâche, choisis le projet, **Worktree** (branche isolée) ou **Local** (ton dossier), puis le modèle et l'effort.
3. La première fois dans un nouveau dossier, Claude Code demande si tu fais confiance au dossier : réponds dans le terminal.
4. Suis tes agents dans la sidebar ou dans **Espaces de travail** (kanban). Clic droit sur un espace pour l'ouvrir dans VS Code ou Cursor, le forker, l'archiver, etc.

### Agents

Page **Agents** (sidebar, ou l'engrenage de la barre d'agents) : crée des agents Claude avec leur propre rôle, instructions, modèle, effort, permissions, outils autorisés et premier message.

- Ils apparaissent dans la barre à côté de « Claude » : un clic ouvre un onglet avec cet agent dans l'espace en cours (sa propre conversation, reprise après un redémarrage).
- Dans « Nouvel espace de travail », le sélecteur « Claude ▾ » permet de lancer tout l'espace avec un agent.
- Ils sont enregistrés au format natif de Claude Code (`~/.claude/agents/<nom>.md`) : ils marchent aussi dans un terminal (`claude --agent <nom>`) et Claude peut les appeler en renfort pendant une session.

Raccourcis : ⌘N nouvel espace · ⌘K rechercher · ⌘T terminal · ⌘D diviser · ⌘⌥1…9 aller à l'espace n · ⇧↵ nouvelle ligne dans Claude.

## Depuis ton iPhone

Supersept a une vue mobile : liste des espaces (ceux qui attendent ta réponse en premier), terminal de Claude avec une barre de saisie et les touches qui manquent au clavier iOS (Esc, flèches, ⇧Tab, ^C…), et création d'un nouvel espace.

1. Sur le Mac : **Réglages → Accès depuis le téléphone → Activer**.
2. Scanne le QR code avec l'appareil photo de l'iPhone, puis dans Safari : **Partager → Sur l'écran d'accueil**. Tu as une icône Supersept qui s'ouvre en plein écran comme une app.
3. Pour y accéder hors de chez toi, installe [Tailscale](https://tailscale.com/download) sur le Mac et l'iPhone (même compte) : un QR code « Tailscale » apparaît. Sans Tailscale, ça ne marche que sur le même Wi‑Fi.

Si l'iPhone n'arrive pas à se connecter, le pare-feu de macOS bloque peut-être `node` : Réglages Système → Réseau → Pare-feu → Options, et autorise les connexions entrantes pour `node`.

Le Mac doit rester allumé et réveillé (Réglages Système → Batterie → Options → empêcher la suspension automatique sur secteur). Le terminal est partagé avec le Mac : il prend la taille de l'écran qui l'a utilisé en dernier.

## Où sont les données

Tout est dans `~/.claude-hub/` :

| Chemin | Contenu |
|---|---|
| `hub.db` | projets, espaces, activité (SQLite) |
| `memory/<projet>.md` | la mémoire de chaque projet |
| `worktrees/` | les git worktrees créés par Supersept |
| `attachments/` | les pièces jointes envoyées à Claude |
| `remote.json` | l'accès téléphone (activé ou non, jeton d'appairage) |

Les conversations elles-mêmes restent celles de Claude Code (`~/.claude/projects`).

## Sécurité

Supersept peut lancer des terminaux sur ta machine, il est donc verrouillé :

- il n'écoute que sur `127.0.0.1` : il est inaccessible depuis le réseau, sauf si tu actives l'accès téléphone ;
- avec l'accès téléphone, seuls les appareils qui ont scanné le QR code (un jeton secret) peuvent se connecter. « Révoquer » change le jeton et déconnecte tous les téléphones. Sur un Wi‑Fi partagé, préfère Tailscale : le trafic local n'est pas chiffré ;
- il refuse les requêtes venant d'autres sites web, de sorte qu'une page ouverte dans ton navigateur ne peut pas le piloter ;
- les agents Claude gardent leur mode de permissions habituel.

Ne l'expose pas sur internet (pas de Vercel, de tunnel public ou de port forwarding) : pour y accéder de l'extérieur, passe par Tailscale.

## Mise à jour

```bash
git pull && npm install && npm run service
```

## Désinstallation

```bash
launchctl bootout gui/$(id -u)/sh.supersept.local
rm ~/Library/LaunchAgents/sh.supersept.local.plist
rm -rf ~/.claude-hub   # optionnel : supprime projets, mémoires et worktrees
```

Logs : `~/.claude-hub.log`.

## Développement

```bash
npm run dev   # serveur avec rechargement + Vite sur http://localhost:5173
```

- `server/` : API Express, PTY (node-pty), hooks Claude Code, git.
- `src/` : React + xterm.js.

Les statuts viennent de hooks Claude Code injectés au lancement de chaque agent via `--settings`.
