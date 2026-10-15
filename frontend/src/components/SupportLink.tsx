type Props = {
  tradeId?: string;
  state: string;
};

const SUPPORT_EMAIL = 'support@micopay.com';

export default function SupportLink({ tradeId, state }: Props) {
  const subject = encodeURIComponent(
    `Soporte — ${tradeId ? `Operación ${tradeId.slice(0, 8)}…` : 'operación sin ID'} — ${state}`
  );
  const body = encodeURIComponent(
    `Hola,\n\nNecesito ayuda.\n\nEstado: ${state}\nOperación ID: ${tradeId || 'N/D'}\n\nGracias.`
  );
  const href = `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`;

  return (
    <a
      href={href}
      className="inline-flex min-h-12 items-center gap-1.5 text-sm text-verde font-bold underline hover:underline font-medium transition-colors"
    >
      <span className="material-symbols-outlined text-[16px]" style={{ fontVariationSettings: '"FILL" 1' }}>
        support_agent
      </span>
      ¿Necesitas ayuda?
    </a>
  );
}