"""Toma una captura del telefono por adb y decodifica el QR de MicoPay que haya en pantalla.

Imprime el texto del QR en stdout, o nada si no encuentra ninguno.
Uso: python qr_from_phone.py [ruta_de_adb]
"""
import os
import subprocess
import sys

import cv2
import numpy as np

adb = sys.argv[1] if len(sys.argv) > 1 else "adb"
png = subprocess.run([adb, "exec-out", "screencap", "-p"], capture_output=True, check=True).stdout
img = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_COLOR)
if img is None:
    sys.exit(0)

detector = cv2.QRCodeDetector()
for scale in (1.0, 0.5, 0.75):
    frame = img if scale == 1.0 else cv2.resize(img, None, fx=scale, fy=scale)
    text, _, _ = detector.detectAndDecode(frame)
    if text:
        print(text)
        break

if os.environ.get("QR_DEBUG_PNG"):
    cv2.imwrite(os.environ["QR_DEBUG_PNG"], img)
