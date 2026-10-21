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

1. **Ajoute un projet** : bouton dossier à côté de « PROJETS » dans la sidebar. Supersept propose aussi les dossiers où tu as déjà utilisé Claude Code.
2. **Nouvel espace de travail** (⌘N) : décris la tâche, choisis le projet, **Worktree** (branche isolée) ou **Local** (ton dossier), puis le modèle et l'effort.
3. La première fois dans un nouveau dossier, Claude Code demande si tu fais confiance au dossier : réponds dans le terminal.
4. Suis tes agents dans la sidebar ou dans **Espaces de travail** (kanban). Clic droit sur un espace pour l'ouvrir dans VS Code ou Cursor, le forker, l'archiver, etc.

Raccourcis : ⌘N nouvel espace · ⌘K rechercher · ⌘T terminal · ⌘D diviser · ⌘⌥1…9 aller à l'espace n · ⇧↵ nouvelle ligne dans Claude.

## Où sont les données

Tout est dans `~/.claude-hub/` :

| Chemin | Contenu |
|---|---|
| `hub.db` | projets, espaces, activité (SQLite) |
| `memory/<projet>.md` | la mémoire de chaque projet |
| `worktrees/` | les git worktrees créés par Supersept |
| `attachments/` | les pièces jointes envoyées à Claude |

Les conversations elles-mêmes restent celles de Claude Code (`~/.claude/projects`).

## Sécurité

Supersept peut lancer des terminaux sur ta machine, il est donc verrouillé :

- il n'écoute que sur `127.0.0.1` : il est inaccessible depuis le réseau ;
- il refuse les requêtes venant d'autres sites web, de sorte qu'une page ouverte dans ton navigateur ne peut pas le piloter ;
- les agents Claude gardent leur mode de permissions habituel.

Ne l'expose pas sur internet (pas de Vercel, de tunnel public ou de port forwarding).

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
