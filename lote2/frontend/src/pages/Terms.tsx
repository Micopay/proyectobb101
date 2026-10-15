interface TermsProps {
  onBack: () => void;
}

const Terms = ({ onBack }: TermsProps) => {
  return (
    <div className="bg-fondo text-tinta min-h-screen flex flex-col pb-10">
      <header className="fixed top-0 left-0 w-full z-50 flex items-center gap-4 px-4 py-4 pt-[max(1rem,env(safe-area-inset-top))] bg-papel border-b-2 border-tinta/60">
        <button
          onClick={onBack}
          className="min-h-12 min-w-12 flex items-center justify-center rounded-sm hover:bg-[#EFF6FA] transition-colors"
          aria-label="Regresar"
        >
          <span className="material-symbols-outlined">arrow_back</span>
        </button>
        <div>
          <h1 className="font-bold text-lg leading-tight">Términos de Servicio</h1>
          <p className="text-[11px] text-gris">Última actualización: mayo 2026</p>
        </div>
      </header>

      <main className="flex-1 mt-[calc(5rem+env(safe-area-inset-top))] px-4 pt-4 space-y-5 max-w-lg mx-auto w-full">
        <div className="bg-amber-50 border border-amber-200 rounded-sm px-4 py-3 flex items-start gap-3">
          <span className="material-symbols-outlined text-amber-600 mt-0.5 text-lg">info</span>
          <p className="text-sm text-amber-800 font-medium">
            BORRADOR — Pendiente de revisión legal. No constituye asesoramiento jurídico.
          </p>
        </div>

        <section className="bg-papel rounded-sm p-5 border-2 border-tinta/60 space-y-4">
          <h2 className="font-bold text-base text-tinta">1. Aceptación de términos</h2>
          <p className="text-sm text-gris leading-relaxed">
            Al usar Micopay aceptas estos términos. Si no estás de acuerdo, no uses el servicio.
            El uso de la app implica que eres mayor de edad y tienes capacidad legal para
            celebrar transacciones financieras en tu país de residencia.
          </p>
        </section>

        <section className="bg-papel rounded-sm p-5 border-2 border-tinta/60 space-y-4">
          <h2 className="font-bold text-base text-tinta">2. Descripción del servicio</h2>
          <p className="text-sm text-gris leading-relaxed">
            Micopay es una plataforma P2P que facilita el intercambio de efectivo físico contra
            activos digitales (XLM/USDC) usando contratos inteligentes en la red Stellar.
            Micopay actúa como intermediario técnico, no como banco ni institución financiera.
          </p>
        </section>

        <section className="bg-papel rounded-sm p-5 border-2 border-tinta/60 space-y-4">
          <h2 className="font-bold text-base text-tinta">3. Responsabilidades del usuario</h2>
          <ul className="text-sm text-gris leading-relaxed list-disc pl-5 space-y-1">
            <li>Usar el servicio solo para transacciones legítimas</li>
            <li>Mantener seguras tus credenciales de acceso</li>
            <li>No usar la plataforma para lavado de dinero u otras actividades ilícitas</li>
            <li>Verificar los datos de la operación antes de confirmar</li>
          </ul>
        </section>

        <section className="bg-papel rounded-sm p-5 border-2 border-tinta/60 space-y-4">
          <h2 className="font-bold text-base text-tinta">4. Comisiones</h2>
          <p className="text-sm text-gris leading-relaxed">
            Micopay cobra una comisión de plataforma visible antes de confirmar cada operación.
            Las comisiones de la red Stellar son mínimas y también corren por cuenta del usuario.
          </p>
        </section>

        <section className="bg-papel rounded-sm p-5 border-2 border-tinta/60 space-y-4">
          <h2 className="font-bold text-base text-tinta">5. Limitación de responsabilidad</h2>
          <p className="text-sm text-gris leading-relaxed">
            Micopay no es responsable por pérdidas derivadas de volatilidad de precios, errores
            del usuario, fallas de la red Stellar, o incumplimiento de la contraparte en una
            transacción P2P. Usas el servicio bajo tu propio riesgo.
          </p>
        </section>

        <section className="bg-papel rounded-sm p-5 border-2 border-tinta/60 space-y-4">
          <h2 className="font-bold text-base text-tinta">6. Cancelación de cuenta</h2>
          <p className="text-sm text-gris leading-relaxed">
            Puedes eliminar tu cuenta en cualquier momento desde la sección de Perfil.
            Nos reservamos el derecho de suspender cuentas que violen estos términos.
          </p>
        </section>

        <section className="bg-papel rounded-sm p-5 border-2 border-tinta/60 space-y-4">
          <h2 className="font-bold text-base text-tinta">7. Contacto</h2>
          <p className="text-sm text-gris leading-relaxed">
            Para dudas sobre estos términos escríbenos a legal@micopay.app.
          </p>
        </section>
      </main>
    </div>
  );
};

export default Terms;
