# Protocole de test manuel — Mise en station polaire

## Prérequis

Aucune caméra ni equipment physique nécessaire. Le mock INDIGO simule une monture.

```bash
# Terminal 1 : Mock INDIGO
source venv/bin/activate
python tests/mock_indigo.py --port 17624

# Terminal 2 : Serveur web
source venv/bin/activate
python run.py 127.0.0.1:17624 --port 8080
```

Ouvrir `http://localhost:8080` dans le navigateur.

---

## Test 1 — Mode Auto complet

**But** : Vérifier que la séquence automatique 3 étapes fonctionne de bout en bout.

### Étapes

1. Cliquer sur l'onglet **Astrométrie** dans la barre de modes
2. Vérifier que les 3 panneaux apparaissent : Solver, Cible, **Polaire**
3. Dans le panneau Polaire, vérifier que le mode **Auto** est sélectionné (bouton actif)
4. Cliquer **Unpark** → la monture doit passer en `park=False`
5. Cliquer **Tracking ON** → la monture doit passer en `tracking=True`
6. Cliquer **Démarrer**

### Résultat attendu

- La barre de progression apparaît avec les 3 étapes
- Étape 1 : "Centre (0h)" → Slew → Solve → ✓ vert
- Étape 2 : "+30min Est" → Slew → Solve → ✓ vert
- Étape 3 : "-30min Ouest" → Slew → Solve → ✓ vert
- Le panneau **Erreur polaire** apparaît avec :
  - Altitude : valeur en arcmin + flèche
  - Azimut : valeur en arcmin + flèche
  - Totale : somme
  - Pôle trouvé : RA/DEC en sexagésimal
  - Canvas schéma

### Vérifications complémentaires

- Les boutons de monture (Tracking, Unpark) restent cliquables pendant la séquence
- Le bouton **Stop** apparaît pendant la séquence, le bouton **Démarrer** disparaît
- En fin de séquence, le bouton **Démarrer** réapparaît, **Stop** disparaît

---

## Test 2 — Mode Manuel

**But** : Vérifier les captures individuelles étape par étape.

### Étapes

1. Cliquer **Reset** pour tout réinitialiser
2. Passer en mode **Manuel** (bouton "Manuel" dans le panneau Polaire)
3. Vérifier que les boutons **"Capturer + Résoudre"** apparaissent sur chaque step
4. Vérifier que le bouton **Démarrer** disparaît
5. Cliquer **Capturer + Résoudre** sur l'étape 1
6. Vérifier que l'étape 1 passe en ✓ vert
7. Cliquer **Capturer + Résoudre** sur l'étape 2
8. Vérifier que l'étape 2 passe en ✓ vert
9. Cliquer **Capturer + Résoudre** sur l'étape 3
10. Vérifier que l'étape 3 passe en ✓ vert

### Résultat attendu

- Après les 3 captures, le panneau **Erreur polaire** apparaît
- Les coordonnées RA/DEC de chaque step sont affichées (pas "--")

---

## Test 3 — Changement d'angle

**But** : Vérifier que les labels s'adaptent à l'angle configuré.

### Étapes

1. Cliquer **Reset**
2. Vérifier que l'angle par défaut est **30** min
3. Vérifier que l'étape 2 affiche **"+30min Est"** et l'étape 3 **"-30min Ouest"**
4. Changer l'angle à **60**
5. Vérifier que les labels passent en format heures : **"+1.0h Est"** / **"-1.0h Ouest"**
6. Changer l'angle à **15**
7. Vérifier que les labels reviennent en minutes : **"+15min Est"** / **"-15min Ouest"**
8. Changer l'angle à **5** (minimum)
9. Vérifier que ça accepte la valeur
10. Essayer de mettre **0** ou **200** → vérifier que le navigateur borne à 5-120

---

## Test 4 — Abort au milieu

**But** : Vérifier la gestion d'interruption pendant la séquence.

### Étapes

1. Passer en mode **Auto**
2. Cliquer **Démarrer**
3. Attendre que l'étape 1 soit terminée (✓ vert)
4. Cliquer **Stop** pendant l'étape 2 (slew ou solve en cours)

### Résultat attendu

- La séquence s'arrête proprement
- L'étape 2 reste en cours ou affiche un état d'erreur
- Les étapes 3 n'est pas démarrée
- Le bouton **Démarrer** réapparaît

---

## Test 5 — Reset après séquence

**But** : Vérifier la réinitialisation complète.

### Étapes

1. Lancer une séquence Auto complète (Test 1)
2. Vérifier que les résultats polaires sont affichés
3. Cliquer **Reset**

### Résultat attendu

- Les 3 steps reviennent en ◻ (pas de coche)
- Les coordonnées RA/DEC des steps reviennent en "--"
- Le panneau **Erreur polaire** disparaît
- La barre de progression disparaît
- Le mode reste sur ce qui était sélectionné (Auto ou Manuel)

---

## Test 6 — Switch mode pendant séquence

**But** : Vérifier la cohérence lors de changements de mode.

### Étapes

1. Lancer une séquence Auto
2. Pendant la séquence, basculer en mode **Manuel**

### Résultat attendu

- Les boutons "Capturer + Résoudre" apparaissent sur les steps
- La séquence en cours ne crash pas

---

## Test 7 — Requêtes réseau

**But** : Vérifier que les actions envoient les bonnes API calls.

Ouvrir l'onglet Network du navigateur (F12).

| Action | Endpoint attendu | Méthode |
|--------|-----------------|---------|
| Tracking ON | `/api/mount/tracking` | POST |
| Unpark | `/api/mount/unpark` | POST |
| Stop (abort) | `/api/mount/abort` | POST |
| Slew (via séquence) | `/api/mount/slew` | POST |
| Résultat polaire | (calcul local, pas d'API) | — |

---

## Observations connues

- Le mock simule un slew de 0.5s (plus rapide que la réalité)
- Les images FITS résolues sont synthétiques (pas du ciel réel)
- Le calcul polaire utilise des positions cibles basées sur LST + latitude du site (config.yaml)
- L'angle configure l'offset HA en minutes (1 min RA = 0.25° HA)
- En mode Auto, le bouton Stop est visible ; en mode Manuel, il est caché (pas de séquence auto à stopper)
