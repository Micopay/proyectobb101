/* Primitivas del sistema "Mercado / Rótulo" (F1).
   Traducidas del CSS del sitio (micopay-landig @ c6b395f), no portadas: ver
   los comentarios de cada archivo para qué cambió y por qué.

   Reglas comunes:
   - Radio 2 px. Canto vivo. `rounded-full` solo en puntos y en el pin del mapa.
   - Borde 2 px sólido. Nunca 1 px, nunca con opacidad.
   - Sombra sólida sin blur, y solo en superficies principales.
   - Área táctil mínima 48 dp en todo lo que se toca.
   - Sin hover, sin gradientes, sin blur, sin glow.
   - Verde y naranja son direccionales: cada uno tiene versión para fondo
     claro y para fondo oscuro, y no son intercambiables.

   Pendiente por fase, para no crear componentes sin uso:
     Sheet       -> con F5 (diálogos del flujo crítico) */

export { default as AmountField } from './AmountField';
export { default as Badge } from './Badge';
export { default as Button } from './Button';
export { default as Card } from './Card';
export { default as Hongo } from './Hongo';
export { default as Label } from './Label';
export { default as MoneyBlock } from './MoneyBlock';
export { default as Pill } from './Pill';
export { default as SignCard } from './SignCard';
export { default as TextField } from './TextField';
