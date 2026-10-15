# ESP-WebSDR

*Read this in [English](README.md).*

### Essayez-le vous-même : [Aperçu du projet](https://espargos.net/espsdr/) · [Visualiseur SDR dans le navigateur](https://espargos.net/espsdr/app/) · [Installateur de firmware dans le navigateur](https://espargos.net/espsdr/app/flash.html)

<img src="docs/espargos-logo.png" width="40%" align="right" alt="Logo ESPARGOS">

Visualiseur de spectre dans le navigateur et installateur de firmware pour les
puces ESP32, avec spectres FFT en direct, waterfalls, et contrôles d'accord, de
gain et de bande passante.

Avec l'aide de LLM, nous avons découvert une fonctionnalité non documentée des
puces ESP32 d'Espressif qui contourne les modems à fonction fixe pour capturer
des échantillons IQ en bande de base bruts. ESP-WebSDR se couple au
[firmware ESP-SDR](https://github.com/ESPARGOS/esp-sdr) pour afficher ces
échantillons sous forme de spectre et de waterfall en direct dans votre
navigateur, transformant les cartes ESP32 compatibles en récepteurs radio
logicielle (SDR) à faible coût.

![Spectre et waterfall ESP-WebSDR](docs/spectrum-demo.jpg)

**Une partie de ce code est générée par IA.**
Bien que nous ayons investi beaucoup d'efforts manuels dans [pyespargos](https://github.com/ESPARGOS/pyespargos) et le firmware de nos réseaux ESPARGOS One, nous n'avons pas le temps de relire manuellement l'intégralité du code source d'ESP-WebSDR.

## Pour commencer

1. Utilisez un navigateur compatible WebSerial ou WebUSB et connectez votre carte en USB.
2. Installez le firmware correspondant avec l'[installateur de firmware](https://espargos.net/espsdr/app/flash.html).
3. Ouvrez le [visualiseur](https://espargos.net/espsdr/app/), connectez-vous à la carte, et sélectionnez une fréquence.

L'installateur et le visualiseur utilisent par défaut **WebSerial sur ordinateur**
et **WebUSB sur mobile**, avec repli sur l'API disponible si nécessaire. Le menu
déroulant Connect de l'installateur propose l'autre transport ; le menu de
connexion du visualiseur permet de choisir l'un ou l'autre. Les connexions
mémorisées du visualiseur conservent le transport précédemment sélectionné.

Pour WebUSB, utilisez le connecteur USB natif de la puce : ce backend prend en
charge les interfaces CDC d'Espressif, y compris USB Serial/JTAG. Utilisez
WebSerial pour les ponts UART externes.
Les deux API nécessitent HTTPS ou localhost.

WebUSB a tout de même besoin d'une autorisation pour revendiquer les interfaces
CDC du périphérique. Un pilote du système d'exploitation peut déjà les détenir ;
utilisez WebSerial sur ces hôtes. Les restrictions USB du navigateur/OS ne
peuvent pas être contournées par ce backend. Après un changement de firmware qui
modifie l'identité USB, sélectionnez à nouveau le périphérique (le mode BOOT peut
être nécessaire).
Voir [architecture du transport et vérifications matérielles](docs/usb-transport.md).

L'installateur inclut également le **profil ESP32-S31 Ethernet / USB pour
[SoapyESPSDR](https://github.com/ESPARGOS/SoapyESPSDR)**. Sélectionnez ce profil
pour diffuser en continu vers des applications SDR de bureau. Il possède sa
propre page de contrôle du récepteur à l'adresse DHCP de la carte et n'utilise
pas ce visualiseur série.

Les cartes ESP32-C2 / ESP8684 sont prises en charge via UART, avec jusqu'à 8 190
échantillons I/Q et des FFT instantanées de 256 à 2048 bins à 80/40/16 MS/s. Le
firmware C2 fourni nécessite un quartz de 26 MHz ; l'installateur vérifie le
quartz avant l'écriture. Pour les ponts CH340, utilisez **Switch to 1 Mbaud**
lorsque le visualiseur signale des erreurs de transfert. La bande passante
analogique du C2 couvre environ 12 à 20 MHz ; zéro sélectionne le réglage de
condensateur ouvert. Les contrôles sont négociés, de sorte que les anciennes
images C2 conservent leur capacité limitée à 80 MS/s et leur contrôle de bande
passante désactivé.

Fermez les autres programmes utilisant le port série. Si l'entrée automatique
dans le bootloader échoue, maintenez BOOT, appuyez brièvement sur RESET, puis
relâchez BOOT et reconnectez-vous dans l'installateur.

Consultez le [guide ESP-SDR](https://espargos.net/espsdr/) pour les puces prises
en charge et la configuration.

## Interface du visualiseur

Dispositions récentes du visualiseur (sur ordinateur, largeur ≥ 851 px) :

- **Panneau de contrôles repliable** — le chevron `‹ / ›` en haut à gauche (dans
  l'en-tête) range le panneau de gauche (fréquence, gain, markers, profils…).
  Une fois replié, le spectre et le waterfall occupent toute la largeur. L'état
  (ouvert / rangé) est mémorisé d'une session à l'autre et restauré sans
  animation au rechargement.
- **Spectre + waterfall sans défilement** — les deux graphes et le pied de page
  tiennent dans la hauteur de l'écran, sans avoir à faire défiler la page. Sur un
  écran trop court, la page redevient défilante plutôt que de rogner le waterfall.
- **Hauteur spectre / waterfall réglable** — glissez la poignée entre les deux
  graphes pour répartir leur hauteur ; double-cliquez-la pour revenir à la
  répartition par défaut. Le réglage est mémorisé et reste toujours borné à
  l'écran (il ne réintroduit jamais de défilement).
- **En-tête rétrécissable** — le chevron `⌃` dans l'en-tête réduit la barre du
  haut (le sous-titre se masque) pour laisser plus de hauteur au spectre et au
  waterfall. L'état est mémorisé.
- **Panneau de debug / trafic UART** (à droite, replié par défaut) — ouvrez-le
  avec le bouton terminal de l'en-tête pour voir le trafic série de contrôle
  TX (`»`) / RX (`«`) — commandes et réponses échangées avec la carte (`INFO`,
  `FREQ`, `OK`, etc.) — ainsi que les events de connexion et les erreurs. Une
  ligne de stats résume transport, baud, trames perdues et erreurs CRC. Le flux
  IQ haut débit (en-têtes `CAP`/`DATA` par trame) n'est **pas** journalisé, pour
  ne rien coûter sur le chemin critique. Bouton **Clear** pour vider le journal.

Sur mobile (largeur ≤ 850 px), le panneau de contrôles s'empile sous l'en-tête
comme auparavant ; les chevrons, le bouton debug, la poignée de redimensionnement
et le panneau de debug ne sont pas affichés.

## Firmware ESPsoup (ESP32-C5)

Le visualiseur est compatible avec le firmware
[ESPsoup pour l'ESP32-C5](https://github.com/pit711/espsoup-firmware), un fork **additif**
de l'ESP-SDR d'ESPARGOS : une carte sous ESPsoup se présente comme un récepteur C5
ordinaire, et le spectre partagé tourne sur son moteur rapide (captures et waterfall plus
rapides, sans aucun réglage). Quand la carte annonce les capacités correspondantes, le
visualiseur expose en plus :

- **Barre de modes au-dessus du spectre** — bascule entre les modes disponibles :
  **I/Q** (captures burst), **Spectre** (FFT on-chip partagée), **Panorama** et
  **Waterfall continu**. Chaque bouton n'apparaît que si le firmware le supporte.
- **Panorama (SWEEP)** — balaye toute la plage que vous définissez (Départ / Arrivée /
  Pas, en MHz) et assemble un spectre large bande en plaçant chaque pas à sa fréquence
  centrale ; l'axe des fréquences couvre toute la plage et chaque balayage complet ajoute
  une ligne au waterfall.
- **Waterfall continu (CSPEC)** — waterfall gap-free haute cadence issu du moteur continu
  on-device (USB natif), avec résolution FFT (16–256) et détecteur (max / moyenne) réglables.
- **Tuning fin (FREQK)** — quand le firmware l'annonce, le champ de fréquence accepte le
  pas de **1 kHz** (ex. `2437.5`), pas seulement le MHz entier.
- **Snapshots longs (BIGCAP)** — en mode I/Q, des tailles de FFT 8192 / 16384 deviennent
  disponibles (jusqu'à 32704 échantillons par capture) pour une trace plus fine / plus de
  moyennage.
- **Diagnostics ESPsoup** dans le panneau de debug — version firmware (`FWOPT`), température
  de la puce (`TEMP`), tas libre / plus gros bloc (`HEAP`), chemin de tuning (`TUNEM`) et
  moteur de capture (`ENGINE`), rafraîchis uniquement hors streaming (une ligne de commande
  arrêterait un flux SPEC / CSPEC / SWEEP).

Avec un autre firmware (ESP-SDR standard, autres puces), ces modes et réglages restent
simplement masqués — le visualiseur se comporte comme avant.

## Configuration sur ordinateur

Utilisez Chrome, Edge ou [Firefox 151 ou ultérieur](https://hacks.mozilla.org/2026/05/web-serial-support-in-firefox/)
sur ordinateur. L'installateur et le visualiseur utilisent **WebSerial** par
défaut, prenant en charge à la fois les ports série USB natifs et les ponts
USB-UART externes.

1. Connectez votre carte avec un câble USB de données et fermez tout moniteur
   série utilisant son port.
2. Ouvrez l'[installateur de firmware](https://espargos.net/espsdr/app/flash.html),
   cliquez sur **Connect via WebSerial**, sélectionnez le port de la carte, et
   installez le firmware ESP-SDR correspondant si nécessaire.
3. Ouvrez le [visualiseur](https://espargos.net/espsdr/app/), cliquez sur
   **Connect ESP-SDR**, et sélectionnez le port. La réception démarre
   automatiquement. Pour sélectionner explicitement le transport de bureau,
   utilisez **Choose WebSerial Device…** dans le menu de connexion.

Sous Windows ou macOS, si un pont USB-UART externe n'apparaît pas comme un port
série, installez le pilote de son fabricant. Le
[guide de connexion série](https://docs.espressif.com/projects/esp-idf/en/release-v5.5/esp32h2/get-started/establish-serial-connection.html)
d'Espressif renvoie vers les pilotes de ponts courants et explique comment
identifier le port.

### Permissions série sous Linux

Si le navigateur liste le port mais ne peut pas l'ouvrir, vérifiez que votre
utilisateur dispose d'un accès en lecture/écriture. L'USB natif apparaît
généralement comme `/dev/ttyACM0` ; les ponts externes apparaissent souvent comme
`/dev/ttyUSB0`. Remplacez par le port réel de votre carte :

```sh
ls -l /dev/ttyACM0
```

Sous Debian/Ubuntu, ajoutez votre utilisateur au groupe du port série, puis
**déconnectez-vous et reconnectez-vous** avant de rouvrir le navigateur :

```sh
sudo usermod -aG dialout "$USER"
```

Arch Linux utilise normalement `uucp` au lieu de `dialout`. Utilisez le groupe
affiché pour votre périphérique ; voir la section des permissions Linux dans le
guide Espressif ci-dessus.

Alternativement, sur un bureau utilisant systemd-logind, une règle udev peut
accorder à l'utilisateur local actif l'accès aux ports série Espressif natifs.
Créez `/etc/udev/rules.d/70-esp-web-sdr.rules` avec cette ligne :

```udev
SUBSYSTEM=="tty", ATTRS{idVendor}=="303a", TAG+="uaccess"
```

Rechargez les règles, puis débranchez et rebranchez la carte :

```sh
sudo udevadm control --reload-rules
```

Cette règle correspond aux périphériques USB Espressif natifs, pas aux ponts
CP210x, CH340 ou FT232. Pour ceux-ci, utilisez la méthode du groupe de port série
ci-dessus. La règle accorde l'accès au port série pour WebSerial ; elle ne libère
pas une interface CDC détenue par le noyau Linux pour WebUSB. Si WebUSB signale
**Unable to claim interface**, choisissez WebSerial. Voir
[dépannage du transport USB](docs/usb-transport.md#chromium-on-desktop-linux-unable-to-claim-interface).

## Chrome sur Android

ESP-WebSDR fonctionne aussi directement dans **Chrome sur Android** : WebUSB
connecte le navigateur à l'ESP32, aucune application Android distincte n'est donc
nécessaire. Le spectre en direct, le waterfall et les contrôles d'accord, de gain
et de bande passante fonctionnent dans le navigateur mobile.

1. Connectez le **connecteur USB natif** d'une carte ESP32 compatible à un
   téléphone ou une tablette Android prenant en charge l'hôte USB / OTG, en
   utilisant un câble USB de données et un adaptateur OTG si nécessaire. Les ponts
   USB-UART externes tels que CP210x, CH340 et FT232 ne sont pas pris en charge
   par ce backend WebUSB.
2. Si la carte n'a pas déjà le firmware ESP-SDR, ouvrez l'
   [installateur de firmware](https://espargos.net/espsdr/app/flash.html) dans
   Chrome. Touchez **Connect via WebUSB**, sélectionnez la carte et accordez
   l'accès USB, puis installez le firmware ESP-SDR correspondant. Si l'entrée dans
   le bootloader échoue, maintenez BOOT, appuyez brièvement sur RESET, relâchez
   BOOT et reconnectez-vous.
3. Ouvrez le [visualiseur](https://espargos.net/espsdr/app/) dans Chrome et
   touchez **Connect ESP-SDR**. Sélectionnez la carte et accordez l'accès
   lorsque cela est demandé ; WebUSB est sélectionné automatiquement sur mobile.
   Vous pouvez aussi sélectionner explicitement **Choose WebUSB Device…** dans le
   menu de connexion.
4. Une fois connecté, la réception démarre automatiquement. Sélectionnez une
   fréquence et ajustez les contrôles pour explorer le spectre et le waterfall.

Si le flashage modifie l'identité USB de la carte, sélectionnez-la à nouveau dans
le visualiseur. Utilisez les liens HTTPS ci-dessus : une page HTTP servie depuis
un autre ordinateur de votre réseau local ne fournit pas le contexte sécurisé
requis par WebUSB.

<img src="docs/android-chrome-screenshot.jpeg" width="320" alt="ESP-WebSDR dans Chrome sur Android, affichant un spectre de puissance 2,4 GHz en direct et un waterfall">

## Contributeurs

<table>
  <tr>
    <td align="center">
      <a href="https://github.com/Jeija">
        <img src="https://github.com/Jeija.png?size=160" width="80" height="80" alt="Florian Euchner"><br>
        <b>Florian Euchner</b>
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/zodoczi">
        <img src="https://github.com/zodoczi.png?size=160" width="80" height="80" alt="Zoltan Doczi"><br>
        <b>Zoltan Doczi</b>
      </a>
    </td>
  </tr>
</table>

## Licence

Sauf indication contraire, ESP-WebSDR est un logiciel libre : vous pouvez le
redistribuer et/ou le modifier selon les termes de la GNU General Public License
telle que publiée par la Free Software Foundation, soit la version 3 de la
licence, soit (à votre choix) toute version ultérieure (`GPL-3.0-or-later`). Voir
[LICENSE](LICENSE) pour les termes complets. Il est fourni sans aucune garantie,
y compris les garanties implicites de qualité marchande ou d'adéquation à un
usage particulier.

Les composants tiers conservent leurs propres licences et avis de copyright. Les
licences des dépendances fournies se trouvent dans `flasher/vendor/` ; la licence
de la police est dans `fonts.css`. Le
[firmware ESP-SDR](https://github.com/ESPARGOS/esp-sdr) qui l'accompagne est sous
licence séparée ; voir sa licence et ses avis concernant les tiers.

L'ESP32-H2 utilise son moteur de capture PHY Bluetooth à 32, 16, environ 10,667
et 6,4 MS/s (codes de débit 7, 6, 8 et 9), avec jusqu'à 16 380 échantillons
complexes et des spectres instantanés de 256 à 2048 bins. Les deux interfaces,
USB Serial/JTAG natif et UART0 (TX GPIO24, RX GPIO23), sont prises en charge.
L'installateur inclut une image H2 pour une flash de 2 Mo ou plus. Le contrôle de
bande passante analogique couvre environ 4 à 11 MHz ; zéro sélectionne le réglage
de filtre le plus large. Les débits inférieurs sont un sous-échantillonnage
matériel sans filtrage anti-repliement automatique. La capture continue n'est pas
annoncée. Sur un adaptateur TX/RX uniquement, entrez en mode téléchargement avec
BOOT/RESET avant l'installation et réinitialisez ensuite ; l'adaptateur ne peut
pas contrôler les broches de reset de la carte.
