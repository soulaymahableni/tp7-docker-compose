# TP7 — Docker avancé et Docker Compose

Multi-stage, utilisateur non-root, PostgreSQL, Docker Compose et Buildx multi-architecture.

## Fichiers rendus

| Fichier | Rôle |
|---|---|
| `Dockerfile` | Build multi-stage (deps → build → runtime), utilisateur `node`, `HEALTHCHECK`, secret de build |
| `.dockerignore` | Exclut `node_modules`, `dist`, `.git`, `.env`, `Dockerfile*`, `compose.yaml`, `*.md` |
| `compose.yaml` | Pile `app` + `db` (PostgreSQL 17) + `adminer`, réseaux `frontend` / `backend`, volume nommé `pgdata` |
| `compose.proxy.yaml` + `nginx/nginx.conf` | Défi 1 : reverse proxy Nginx devant 3 réplicas de `app` |
| `.env.example` | Variables attendues (le vrai `.env` n'est **pas** versionné) |
| `captures/` | Captures d'écran |

## Tableau comparatif

| Indicateur | `naive` | `multistage` |
|---|---|---|
| Taille de l'image | 1,67 Go (417 Mo compressée) | 250 Mo (63,3 Mo compressée) |
| Temps de build (à froid) | 5,8 s | 13,1 s |
| Temps de build (code modifié) | 5,0 s (`npm install` réexécuté) | 5,6 s (`npm ci` **CACHED**) |
| Vulnérabilités HIGH/CRITICAL | 486 (464 HIGH / 22 CRITICAL) | 6 (6 HIGH / 0 CRITICAL) |
| Utilisateur | `root` (uid=0) | `node` (uid=1000) |

![Comparaison des images](captures/image-comparison.png)

### Analyse

- **Taille** : l'image multi-stage est environ **6,7 fois plus petite**. Elle repose sur Alpine au lieu de Debian, et seuls `dist/`, les dépendances de production et `package.json` sont copiés dans l'image finale (pas de TypeScript, pas de `@types`, pas de sources).
- **Sécurité** : on passe de **486 à 6 vulnérabilités**. La quasi-totalité venait du système Debian de `node:24`. Les 6 restantes viennent de `npm`, livré avec l'image `node` ; piste d'amélioration : le supprimer de l'image finale.
- **Temps à froid** : le multi-stage est plus lent ici (3 étapes, `npm prune`, copies entre étapes), et l'image de base `node:24` était déjà présente localement.
- **Code modifié** : les temps sont proches car le projet n'a que 2 dépendances (`npm install` ≈ 1,5 s). La différence est dans le comportement : la naïve **réexécute** `npm install`, la multi-stage **réutilise** `npm ci` depuis le cache. Sur un vrai projet avec des centaines de dépendances, le gain serait de plusieurs minutes.
- **Utilisateur** : la multi-stage tourne en `node` (uid 1000). Un processus root dans un conteneur serait root sur le noyau de l'hôte en cas d'évasion.

![Non-root](captures/non-root.png)

## Réponses aux questions

**Pourquoi `npm install` est-il réexécuté dans l'image naïve ?**
`COPY . .` est placé avant `npm install`. Modifier `src/server.ts` change cette couche, ce qui invalide toutes les couches suivantes. Dans le multi-stage, seuls `package.json` et `package-lock.json` sont copiés avant `npm ci` : cette couche reste en cache tant que les dépendances ne changent pas.

**Pile Compose** : `db` passe `healthy` (`pg_isready`) avant le démarrage de `app` (`depends_on: condition: service_healthy`). `app` est aussi `healthy` grâce au `HEALTHCHECK` du Dockerfile.

![Compose ps](captures/compose-ps.png)

![Adminer](captures/adminer-visits.png)

**Persistance — que fait `docker compose down -v` ?**
Après `docker compose down` puis `up -d`, le compteur reprend (6) alors que le conteneur a changé (`host` différent) : les données sont dans le volume nommé `pgdata`. `docker compose down -v` supprime **aussi** les volumes nommés : toutes les données sont perdues et le compteur repart à 1.

![Persistance](captures/persistence.png)

**Isolation réseau**
`db` n'a pas de `ports:` et n'est que sur le réseau `backend`. Depuis la VM, `psql -h localhost` échoue (`Connection refused`), alors que `app` et `adminer` joignent `db:5432` par le DNS interne de Compose.

![Isolation réseau](captures/isolation-reseau.png)

**Problème de `--scale app=2` avec `ports: "3000:3000"`**
Deux conteneurs ne peuvent pas publier le même port de l'hôte : `Bind for 0.0.0.0:3000 failed: port is already allocated`. Solution : ne plus publier de port sur `app` et placer devant un reverse proxy (Nginx), seul à publier le port 80, qui répartit les requêtes entre les réplicas.

## Buildx multi-architecture

Image publiée sur Docker Hub : **`hablani/visits-app:1.0.0`**, avec un manifest list `linux/amd64` + `linux/arm64` (les entrées `unknown/unknown` sont les attestations de build).

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t hablani/visits-app:1.0.0 --push .
docker buildx imagetools inspect hablani/visits-app:1.0.0
```

![Manifest multi-arch](captures/buildx-manifest.png)

## Défis

**1. Reverse proxy Nginx + 3 réplicas**

```bash
docker compose -f compose.yaml -f compose.proxy.yaml up -d --scale app=3
for i in $(seq 1 12); do curl -s http://localhost/; echo; done
```

`compose.proxy.yaml` retire le port de `app` (`ports: !reset []`) et ajoute Nginx sur le port 80. Le bloc `upstream` de Nginx répartit les requêtes en round-robin : le champ `host` alterne entre 3 conteneurs (`6edab30a1afd`, `c389b424fb4a`, `867ee21a77bc`).

![Reverse proxy](captures/reverse-proxy.png)

**2. Secret de build BuildKit**

```dockerfile
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci
```

```bash
docker build --secret id=npmrc,src=$HOME/npmrc-test -t visits-app:secret .
docker history --no-trunc visits-app:secret | grep -c "SECRET-TP7"   # → 0
```

Le fichier n'existe que pendant `npm ci` : il n'apparaît dans aucune couche de l'image.

![Secret de build](captures/secret-build.png)

## Adaptations à l'environnement

- Port **8080** déjà utilisé sur la VM : Adminer publié sur **8088**.
- Port **80** utilisé par Apache : Apache arrêté temporairement pour le défi Nginx.
- Réseau lent (erreurs `tls: bad record MAC`) : miroir `mirror.gcr.io` configuré pour Docker et pour BuildKit, téléchargements limités à 1 en parallèle.
- Disque presque plein : nettoyage du cache de build, du cache Trivy et des images intermédiaires avant la partie Buildx.
