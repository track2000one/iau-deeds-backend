ضع الملف التالي في مشروع الـ Backend:

C:\iau-deeds-backend-only\src\services\googleDrive.js

ثم نفذ:
cd C:\iau-deeds-backend-only
git add src/services/googleDrive.js
git commit -m "Add missing Google Drive service"
git push

المتغيرات المدعومة:
1) GOOGLE_SERVICE_ACCOUNT_JSON + GOOGLE_DRIVE_FOLDER_ID
أو
2) GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY + GOOGLE_DRIVE_FOLDER_ID
