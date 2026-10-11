# WhatsApp PDF downloader

Bot WhatsApp base sur Baileys. Il conserve sa session localement dans `auth_info_baileys/`, écoute les messages et télécharge les PDF de 100 Mo maximum dans `downloads/<numéro>/`. Si SFTP est configuré, il en envoie également une copie vers `<SFTP_REMOTE_DIR>/<numéro>/`.

## Démarrage

```sh
npm install
npm start
```

Au premier démarrage, scannez le QR code affiché dans le terminal avec WhatsApp, depuis **Appareils connectés**. Les démarrages suivants réutilisent la session locale.

## Configuration SFTP facultative

Copiez `.env.example` vers `.env`, puis renseignez l’hôte, le port, l’utilisateur et un mot de passe ou le chemin vers une clé privée. Le bot crée le dossier distant automatiquement. Le fichier `.env` est ignoré par Git ; ne partagez pas vos identifiants.

Si `SFTP_HOST` n’est pas renseigné, le bot fonctionne en mode local uniquement. En cas d’échec SFTP, la copie locale est conservée et le terminal affiche l’erreur.

Le bot réagit avec ⬇️ pendant le téléchargement, ✅ une fois le fichier enregistré, 🚫 si le PDF dépasse 100 Mo, et ❌ en cas d’échec.

Pour reconnecter un autre compte, arrêtez le bot, supprimez `auth_info_baileys/` puis relancez-le. Gardez cette session privée : elle permet d’accéder au compte WhatsApp lié.