# Noctua — Pilotez votre setup astro autrement. Moderne, esthétique, performant — et léger.

> **Une seule page web, hébergée sur votre PC distant (même un Raspberry Pi au pied de la monture), accessible partout : téléphone, tablette ou PC dans le navigateur. Pas d'app, pas de store, pas de RDP/VNC.**

**Noctua couvre toutes les fonctionnalités d'un logiciel astro moderne et abouti**, mais se distingue là où les autres s'arrêtent : **mode serveur natif** (vs N.I.N.A. desktop Windows) + **légèreté extrême** — vanilla JS sans build, pas de framework, sky map 41k étoiles à 60 FPS sur un simple canvas. Puissant comme un pro, léger comme une page web.

**Universel : INDI, INDIGO et ASCOM via INDIGO.** Noctua ne parle qu'un seul protocole `INDIGO/INDI (TCP 7624)` à `indigo_server`. Le serveur charge vos drivers natifs **INDIGO**, **INDI** ou **ASCOM** (ZWO, QHY… sous Windows) — Noctua les voit comme des appareils INDIGO. Un middleware, tous les setups.

> **Statut actuel : alpha** — testé en simulation et sur tablette au labo, **pas encore en conditions réelles au pied de la monture**. Les retours terrain sont justement ce qui fera passer en bêta.

---

## Nouveau — Alpha mobile / tablette (`portage-mobile` `v19`)

**Pensé pour la tablette au pied de la monture, utilisable au téléphone.**

- **Ergonomie tactile** : bandeau pleine largeur en haut, **colonne d'icônes à droite** sous le bandeau, **Modes/Ateliers** en bas (7 icônes), swipe entre modes, panneaux empilés sans recouvrement. Carte du ciel fixe derrière — glissez, pincez, zoomez même avec les panneaux ouverts.
- **Lisibilité nocturne** : 5 palettes `Noctua / Sobre / Graphite / Twilight / Ember` + LEDs ultra-compactes `T C A F R/W` **gris neutre → vert éclatant `#44cc44`** (visibles même en `Graphite`), qui disent d'un coup d'œil quels devices sont connectés.
- **Matériel simplifié** : la ligne `Driver` quitte le bandeau — tout se fait dans l'atelier **Matériel**. Pour la monture, choisissez **Série `/dev/ttyUSB0`** ou **Réseau `host:port`** (`192.168.1.10:7624`), **sauvegardé dans le profil**. Un profil = un setup, prêt en un tap.

---

## Essayer l'alpha

```bash
git fetch && git checkout portage-mobile
./start.sh 192.168.1.x:7624 --port 8080
# puis http://<ip-pc>:8080 depuis n'importe quel appareil du réseau
```

**Sans matériel (test à blanc) :**
```bash
./start-mock-server.sh --port 17624   # terminal 1 : INDIGO simulé
./start.sh 127.0.0.1:17624 --port 8080 # terminal 2 : Noctua sur le mock
```

Branche poussée : `origin/portage-mobile`. PWA installable, thème sombre par défaut.

---

## Appel à la communauté — Rejoignez le développement

**Contribuez directement à Noctua, dès l'alpha.** Code MIT, léger (vanilla JS sans build) : chaque retour et chaque PR comptent.

**Comment participer maintenant :**
- **Testez** votre setup (monture série `/dev/ttyUSB0` ou réseau `host:port`) et ouvrez une **Issue** avec un screen mobile + votre config
- **Codez** : prenez un `good first issue`, proposez un fix tactile, une trad, une amélioration LEDs/colonne
- **Partagez** : une idée d'ergonomie vaut une PR

**Où :** GitHub `portage-mobile` → Discussions / Issues `alpha`, ou répondez à ce message. On construit la bêta ensemble — votre terrain fait la différence.

---

*Noctua — le plaisir de piloter, enfin à portée de main.*
