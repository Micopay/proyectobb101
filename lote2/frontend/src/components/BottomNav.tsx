import { useTranslation } from 'react-i18next';

/* Barra de navegación — F2 del rediseño "Mercado / Rótulo".

   La versión anterior concentraba cinco prohibiciones del sistema en una
   sola línea: radio superior de 32 px, blur de fondo, fondo translúcido,
   sombra difuminada y píldoras redondas. Ahora es un cintillo opaco con una
   regla de 2 px arriba, y la pestaña activa se marca invirtiendo el color
   —tinta sobre papel— igual que .pill[data-on="true"] en el sitio.

   Se conserva a propósito, porque es convención de plataforma y no estética:
     - el padding inferior con env(safe-area-inset-bottom) para el gesto
     - aria-current="page" y aria-label en cada botón
     - anillo de foco visible
     - el eje FILL del icono, que refuerza el estado activo sin depender
       solo del color

   Área táctil: 56 dp por botón, por encima del mínimo de 48. */

interface BottomNavProps {
  currentPage: string;
  onNavigate: (page: string) => void;
  /**
   * CASH-7: contrato neutral. Antes se llamaba `isMerchant` y lo alimentaba
   * un `sellerUser` con valor, o sea "hay sesion" disfrazado de "es
   * comercio". RED-2 lo atara al estado de inscripcion en Red MicoPay.
   */
  showProviderTab?: boolean;
}

const BottomNav = ({ currentPage, onNavigate, showProviderTab = false }: BottomNavProps) => {
  const { t } = useTranslation();

  const btn = (page: string, icon: string, label: string) => {
    const activa = currentPage === page;
    return (
      <button
        onClick={() => onNavigate(page)}
        aria-label={label}
        aria-current={activa ? 'page' : undefined}
        className={`flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 rounded-sm px-1 py-1.5 transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-tinta ${
          activa ? 'bg-tinta text-papel' : 'text-gris'
        }`}
      >
        <span
          aria-hidden="true"
          className="material-symbols-outlined text-[22px]"
          style={{ fontVariationSettings: activa ? '"FILL" 1' : '"FILL" 0' }}
        >
          {icon}
        </span>
        <span className="text-[10px] font-bold uppercase tracking-[.06em] leading-none">
          {label}
        </span>
      </button>
    );
  };

  return (
    <nav className="fixed bottom-0 left-0 z-50 flex w-full items-stretch gap-1 border-t-2 border-tinta bg-papel px-2 pt-2 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      {btn('home', 'home', t('nav.home'))}
      {btn('pay', 'swap_horiz', t('nav.pay'))}
      {showProviderTab
        ? btn('inbox', 'inbox', t('nav.inbox'))
        : btn('cetes', 'savings', t('nav.invest'))}
      {btn('explore', 'explore', t('nav.explore'))}
      {btn('profile', 'person', t('nav.profile'))}
    </nav>
  );
};

export default BottomNav;
