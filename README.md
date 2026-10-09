# Paseo · tableau de bord

Une vue d'ensemble de tous vos agents Paseo : ce qui attend votre réponse, ce qui tourne, ce qui a échoué, ce qui est fini et ce qui est planifié, rangé par projet et par workspace. Plus une page de métriques.

## Démarrer

Il faut Node 22 ou plus récent (le SDK utilise le WebSocket natif de Node).

```bash
npm install
npm start                 # se connecte à ws://127.0.0.1:6767/ws
```

Puis ouvrez http://127.0.0.1:4317.

Pour essayer sans daemon, avec une flotte simulée qui évolue toute seule :

```bash
npm run demo
```

### Options

| Option | Variable d'environnement | Défaut |
| --- | --- | --- |
| `--url` | `PASEO_URL` | `ws://127.0.0.1:6767/ws` |
| `--password` | `PASEO_PASSWORD` | aucun |
| `--port` | `PORT` | `4317` |
| `--host` | `HOST` | `127.0.0.1` |
| `--interval` (ms) | `PASEO_DASHBOARD_INTERVAL` | `4000` |
| `--demo` | `PASEO_DASHBOARD_DEMO=1` | désactivé |
| `--auth` (`user:motdepasse`) | `PASEO_DASHBOARD_AUTH` | aucune |

Daemon sur une autre machine (devbox, homelab) :

```bash
npm start -- --url ws://devbox:6767/ws --password "$PASEO_PASSWORD"
```

Le serveur écoute sur `127.0.0.1` par défaut : il affiche les titres de vos tâches. Pour l'exposer, mettez-le derrière un reverse proxy HTTPS et passez `--auth user:motdepasse` (authentification HTTP Basic) : sans cela, il refuse d'écouter ailleurs que sur `127.0.0.1`.

## Ce que montre la page Tâches

- **Le bandeau d'états** compte les tâches par état et sert de filtre (cliquez pour combiner).
  - À valider : l'agent attend une permission ou une réponse.
  - En erreur : l'agent s'est arrêté sur une erreur et n'est pas archivé.
  - En cours : un tour est en cours.
  - À relire : fini, mais pas encore consulté dans Paseo.
  - À faire : prochaines exécutions des tâches planifiées (`paseo schedule`).
  - Terminé : fini sur la période choisie (12 h, 24 h, 7 jours).
- **Par workspace** : chaque workspace a une ligne de temps. À gauche de la ligne « maintenant », les tâches passées et en cours ; à droite, la zone hachurée montre les exécutions planifiées. Les workspaces qui ont besoin de vous remontent en premier. Cliquez sur un workspace pour replier sa liste, sur une tâche pour voir le détail (demande en attente, erreur, coût, tokens, contexte, identifiant).
- **Par état** : la même chose en colonnes, façon kanban.
- `/` place le curseur dans la recherche ; `Échap` ferme le détail.

Les états suivent la même règle de priorité que le daemon (`deriveAgentStateBucket`) : une permission en attente l'emporte sur une erreur, qui l'emporte sur « en cours ». Le statut affiché pour un workspace est celui calculé par le daemon.

## Métriques

Tâches terminées sur 7 jours (avec comparaison aux 7 jours précédents), taux de réussite, durée médiane, coût et tokens, tâches qui attendent votre retour, terminées par jour, heures d'activité, distribution des durées, répartition par agent et coût par workspace. Chaque graphique a un tableau « Voir les données ».

Le coût et les tokens viennent de `lastUsage` de chaque agent, tels que remontés par le provider : ils valent zéro pour les providers qui ne les exposent pas.

## Comment ça marche

```
navigateur ⇄ SSE ⇄ server.mjs ⇄ @getpaseo/client ⇄ daemon Paseo
```

`server.mjs` interroge le daemon toutes les 4 s (workspaces, agents archivés compris, et planifications), normalise les données (`lib/normalize.mjs`) et pousse l'instantané aux navigateurs. Si le daemon tombe, la page garde les dernières données, l'indique et se reconnecte seule.

Les planifications sont lues via le client bas niveau du SDK (`@getpaseo/client/internal/daemon-client`), car elles ne sont pas encore exposées par l'API publique. Si ce chemin change dans une future version, la colonne « À faire » restera vide sans casser le reste.

## Tests

```bash
npx playwright install chromium   # une fois
npm test
```

- `tests/normalize.test.mjs` : règles d'états, rattachement des agents aux workspaces, planifications.
- `tests/e2e-demo.test.mjs` : serveur + navigateur sur la flotte de démo figée (compteurs, filtres, recherche, détail, replis persistants, vue par état, métriques recoupées avec les données brutes, thème sombre, clavier, mobile).
- `tests/e2e-paseo.test.mjs` : chemin complet via la source Paseo, avec un module qui imite le SDK et ses payloads (pagination, agents archivés, planifications, mise à jour en direct sans recharger, panne puis reprise du daemon).

## Sur ai-dedicated-server

Le daemon Paseo écoute sur `127.0.0.1:8167` et le dashboard sur `127.0.0.1:8170` (plage de ports de paul). Installer avec `pnpm install` (pas de `yarn.lock`), puis :

```bash
PASEO_URL=ws://127.0.0.1:8167/ws PORT=8170 node server.mjs
```

Le mot de passe et les variables sont dans `~/.config/paseo-dashboard/env` (mode 600) :

```bash
set -a; . ~/.config/paseo-dashboard/env; set +a; node server.mjs
```

Sur le web : `https://paul.<domaine du serveur>/dashboard/`, un bloc `location /dashboard/` dans le vhost nginx de l'instance Cozy (copie modifiée gardée dans `~/.config/paseo-dashboard/cozy-paul.conf`, à installer en root). Sans nginx, le tunnel SSH `ssh -L 8170:127.0.0.1:8170 paul@ai-dedicated-server` puis http://127.0.0.1:8170.
