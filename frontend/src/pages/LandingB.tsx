import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

// ── Design tokens (marca LMTM: dark tech + dorado) ──────────────────
const AMBER = '#E8A020';
const AMBER_SOFT = 'rgba(232,160,32,0.12)';
const CHARCOAL = '#0C0E12';
const SURFACE = '#12151B';
const SURFACE2 = '#181C24';
const BORDER = 'rgba(255,255,255,0.07)';
const TEXT = '#E8EBF2';
const MUTED = 'rgba(232,235,242,0.45)';
const GREEN = '#25D366';
const EMERALD = '#34D399';
const IG = '#E1306C';
const MSN = '#0084FF';
const EASE = 'cubic-bezier(0.23, 1, 0.32, 1)';
const SYNE = '"Syne", sans-serif'; // solo logo (identidad de marca)
const DISPLAY = '"Sora", "Plus Jakarta Sans", "DM Sans", sans-serif'; // titulares
const MONO = '"JetBrains Mono", monospace';

// ── Hooks ────────────────────────────────────────────────────────────
const prefersReduced = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function useReveal(threshold = 0.15) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (prefersReduced()) { setVisible(true); return; }
    const obs = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) { setVisible(true); obs.disconnect(); } },
      { threshold },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [threshold]);
  return { ref, visible };
}

type Dir = 'up' | 'left' | 'right';
function reveal(visible: boolean, delay = 0, dir: Dir = 'up'): React.CSSProperties {
  const hidden = dir === 'up' ? 'translateY(36px)' : dir === 'left' ? 'translateX(-48px)' : 'translateX(48px)';
  return {
    opacity: visible ? 1 : 0,
    transform: visible ? 'translate(0,0)' : hidden,
    transition: `opacity 650ms ${EASE} ${delay}ms, transform 650ms ${EASE} ${delay}ms`,
    willChange: 'opacity, transform',
  };
}

function useCountUp(target: number, visible: boolean, duration = 1700) {
  const [val, setVal] = useState(0);
  useEffect(() => {
    if (!visible) return;
    if (prefersReduced()) { setVal(target); return; }
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / duration);
      setVal(Math.round(target * (1 - Math.pow(1 - p, 4))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [visible, target, duration]);
  return val;
}

// ── SVG icons (stroke 1.5, sin emojis) ───────────────────────────────
const Icon = ({ d, color = AMBER }: { d: string; color?: string }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);
const ICONS = {
  bot: 'M12 8V4m0 0H8m4 0h4M5 12a7 7 0 0 1 14 0v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6Zm4 3h.01M15 15h.01',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2m20 0v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6m20 0-3.5-7A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1L2 12',
  kanban: 'M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v7h-4z',
  calendar: 'M8 2v4M16 2v4M3 9h18M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Zm4 9 2 2 4-4',
  pin: 'M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Zm-8 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  chart: 'M3 3v18h18M8 17V9m4 8V5m4 12v-6',
  check: 'M20 6 9 17l-5-5',
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  shield: 'M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10Zm-3-10 2 2 4-4',
};

// ── Botones ──────────────────────────────────────────────────────────
const BTN: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 10, padding: '15px 30px',
  background: `linear-gradient(135deg, #F5B840 0%, ${AMBER} 60%, #C07818 100%)`,
  color: CHARCOAL, border: 'none', borderRadius: 10, fontFamily: DISPLAY,
  fontWeight: 700, fontSize: 15.5, cursor: 'pointer', letterSpacing: '0.01em',
  boxShadow: '0 8px 32px rgba(232,160,32,0.25)',
  transition: `transform 160ms ${EASE}, box-shadow 220ms ${EASE}`,
};
const BTN_GHOST: React.CSSProperties = {
  ...BTN, background: 'transparent', color: TEXT, boxShadow: 'none',
  border: `1px solid rgba(255,255,255,0.14)`,
};

// ── Simulación 1: chat WhatsApp vivo ─────────────────────────────────
type ChatMsg = { from: 'user' | 'bot'; text?: string; card?: boolean };
const SCRIPT: ChatMsg[] = [
  { from: 'user', text: 'Hola! Busco depto 2 ambientes en alquiler cerca de Plaza San Martín' },
  { from: 'bot', text: '¡Hola! 👋 Soy el asistente de la inmobiliaria. Te busco opciones a menos de 5 km de Plaza San Martín…' },
  { from: 'bot', card: true },
  { from: 'user', text: 'Me encanta el segundo. ¿Puedo visitarlo el sábado?' },
  { from: 'bot', text: 'Listo ✅ Visita agendada: sábado 11:00 hs. Te mando recordatorio el día antes. ¿Tu nombre completo?' },
];

function ChatDemo() {
  const [count, setCount] = useState(0);
  const [typing, setTyping] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const { ref, visible } = useReveal(0.3);

  useEffect(() => {
    if (!visible) return;
    if (prefersReduced()) { setCount(SCRIPT.length); return; }
    let cancelled = false;
    let timers: ReturnType<typeof setTimeout>[] = [];
    const run = () => {
      setCount(0);
      let t = 600;
      SCRIPT.forEach((m, i) => {
        if (m.from === 'bot') {
          timers.push(setTimeout(() => !cancelled && setTyping(true), t));
          t += m.card ? 1400 : 1100;
        }
        timers.push(setTimeout(() => {
          if (cancelled) return;
          setTyping(false);
          setCount(i + 1);
        }, t));
        t += 1500;
      });
      timers.push(setTimeout(() => !cancelled && run(), t + 4500)); // loop
    };
    run();
    return () => { cancelled = true; timers.forEach(clearTimeout); };
  }, [visible]);

  useEffect(() => {
    boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight, behavior: 'smooth' });
  }, [count, typing]);

  return (
    <div ref={ref} style={{
      width: '100%', maxWidth: 420, borderRadius: 20, overflow: 'hidden',
      border: `1px solid ${BORDER}`, background: SURFACE,
      boxShadow: '0 32px 80px rgba(0,0,0,0.5), 0 0 0 1px rgba(232,160,32,0.06)',
      ...reveal(visible, 150, 'right'),
    }}>
      {/* header estilo WhatsApp */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', background: '#1F2C24', borderBottom: `1px solid ${BORDER}` }}>
        <div style={{ width: 34, height: 34, borderRadius: '50%', background: GREEN, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: SYNE, fontWeight: 800, fontSize: 13, color: '#fff' }}>IA</div>
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: TEXT }}>Inmobiliaria · Asistente</div>
          <div style={{ fontSize: 11, color: GREEN, display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: GREEN, display: 'inline-block' }} className="lp-pulse" />
            en línea 24/7
          </div>
        </div>
        <div style={{ marginLeft: 'auto', fontSize: 10.5, fontFamily: MONO, color: MUTED }}>03:12 AM</div>
      </div>
      {/* mensajes */}
      <div ref={boxRef} style={{ height: 380, overflowY: 'hidden', padding: 14, display: 'flex', flexDirection: 'column', gap: 8, background: 'radial-gradient(circle at 80% 10%, rgba(37,211,102,0.04), transparent 50%)' }}>
        {SCRIPT.slice(0, count).map((m, i) => (
          <div key={i} className="lp-msg" style={{ display: 'flex', justifyContent: m.from === 'user' ? 'flex-end' : 'flex-start' }}>
            {m.card ? (
              <div style={{ maxWidth: '85%', borderRadius: '12px 12px 12px 4px', background: SURFACE2, border: `1px solid ${BORDER}`, overflow: 'hidden' }}>
                <div style={{ height: 84, background: 'linear-gradient(120deg, #2A2F3A 0%, #3A4150 100%)', position: 'relative' }}>
                  <span style={{ position: 'absolute', bottom: 8, left: 10, fontSize: 10, fontFamily: MONO, background: 'rgba(0,0,0,0.55)', color: '#fff', padding: '2px 7px', borderRadius: 5 }}>📍 a 1,2 km de Plaza San Martín</span>
                </div>
                <div style={{ padding: '10px 12px' }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: TEXT }}>Depto 2 amb · San Martín al 1200</div>
                  <div style={{ fontSize: 12, fontFamily: MONO, color: AMBER, marginTop: 3 }}>ARS 520.000/mes</div>
                  <div style={{ marginTop: 8, fontSize: 11.5, fontWeight: 700, color: GREEN, border: `1px solid rgba(37,211,102,0.35)`, borderRadius: 7, padding: '6px 0', textAlign: 'center' }}>Agendar visita</div>
                </div>
              </div>
            ) : (
              <div style={{
                maxWidth: '82%', padding: '9px 13px', fontSize: 13, lineHeight: 1.5, color: TEXT,
                background: m.from === 'user' ? '#1F3D2B' : SURFACE2,
                border: `1px solid ${m.from === 'user' ? 'rgba(37,211,102,0.2)' : BORDER}`,
                borderRadius: m.from === 'user' ? '12px 12px 4px 12px' : '12px 12px 12px 4px',
              }}>{m.text}</div>
            )}
          </div>
        ))}
        {typing && (
          <div className="lp-msg" style={{ display: 'flex' }}>
            <div style={{ padding: '12px 16px', background: SURFACE2, border: `1px solid ${BORDER}`, borderRadius: '12px 12px 12px 4px', display: 'flex', gap: 5 }}>
              <span className="lp-dot" /><span className="lp-dot" style={{ animationDelay: '0.15s' }} /><span className="lp-dot" style={{ animationDelay: '0.3s' }} />
            </div>
          </div>
        )}
      </div>
      <div style={{ padding: '10px 16px', borderTop: `1px solid ${BORDER}`, fontSize: 11, fontFamily: MONO, color: MUTED, display: 'flex', justifyContent: 'space-between' }}>
        <span>IA respondió en 4 seg</span>
        <span style={{ color: EMERALD }}>lead calificado ✓</span>
      </div>
    </div>
  );
}

// ── Simulación 2: mini Kanban con lead que avanza solo ───────────────
const KCOLS = ['Nuevo', 'Calificado', 'Visita agendada'];
function KanbanDemo({ visible }: { visible: boolean }) {
  const [col, setCol] = useState(0);
  const [score, setScore] = useState(24);
  useEffect(() => {
    if (!visible || prefersReduced()) return;
    const id = setInterval(() => {
      setCol(c => {
        const n = (c + 1) % 3;
        setScore(n === 0 ? 24 : n === 1 ? 58 : 86);
        return n;
      });
    }, 2600);
    return () => clearInterval(id);
  }, [visible]);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
      {KCOLS.map((name, i) => (
        <div key={name} style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 12, minHeight: 180 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: i === 0 ? MUTED : i === 1 ? AMBER : EMERALD, display: 'inline-block' }} />
            <span style={{ fontSize: 11.5, fontWeight: 700, color: TEXT, letterSpacing: 0.3 }}>{name}</span>
          </div>
          {/* cards fantasma fijas */}
          <div style={{ height: 34, borderRadius: 9, background: SURFACE2, border: `1px solid ${BORDER}`, marginBottom: 8, opacity: 0.45 }} />
          {i === 2 && <div style={{ height: 34, borderRadius: 9, background: SURFACE2, border: `1px solid ${BORDER}`, marginBottom: 8, opacity: 0.45 }} />}
          {/* card viva */}
          {col === i && (
            <div key={col} className="lp-msg" style={{ borderRadius: 10, background: SURFACE2, border: `1px solid rgba(232,160,32,0.35)`, padding: '10px 11px', boxShadow: '0 8px 24px rgba(0,0,0,0.35)' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: TEXT }}>Martina G.</div>
              <div style={{ fontSize: 10.5, color: MUTED, margin: '2px 0 7px' }}>Depto 2 amb · Alquiler</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 9.5, fontFamily: MONO, color: GREEN }}>WhatsApp</span>
                <span style={{ fontSize: 10, fontFamily: MONO, fontWeight: 700, color: score > 70 ? EMERALD : AMBER, background: score > 70 ? 'rgba(52,211,153,0.12)' : AMBER_SOFT, padding: '2px 8px', borderRadius: 6 }}>
                  score {score}
                </span>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Stats con count-up ────────────────────────────────────────────────
function Stat({ value, prefix = '', suffix = '', label, visible, delay }: {
  value: number; prefix?: string; suffix?: string; label: string; visible: boolean; delay: number;
}) {
  const n = useCountUp(value, visible);
  return (
    <div style={{ textAlign: 'center', ...reveal(visible, delay) }}>
      <div style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 'clamp(2rem, 4.5vw, 3.1rem)', color: TEXT, fontVariantNumeric: 'tabular-nums' }}>
        {prefix}<span style={{ color: AMBER }}>{n.toLocaleString('es-AR')}</span>{suffix}
      </div>
      <div style={{ fontSize: 13, color: MUTED, marginTop: 6, letterSpacing: 0.2 }}>{label}</div>
    </div>
  );
}

// ── Landing ──────────────────────────────────────────────────────────
export default function LandingB() {
  const navigate = useNavigate();
  const [scrolled, setScrolled] = useState(false);
  const [heroIn, setHeroIn] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setHeroIn(true), 60);
    const onScroll = () => setScrolled(window.scrollY > 40);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { clearTimeout(t); window.removeEventListener('scroll', onScroll); };
  }, []);

  const stats = useReveal(0.35);
  const feat = useReveal(0.12);
  const kanban = useReveal(0.3);
  const how = useReveal(0.2);
  const testi = useReveal(0.25);
  const cta = useReveal(0.3);

  const goDemo = () => document.getElementById('demo-kanban')?.scrollIntoView({ behavior: prefersReduced() ? 'auto' : 'smooth' });

  const FEATURES = [
    { icon: ICONS.bot, title: 'IA que vende, no que chatea', desc: 'Entrenada con tu inventario (Tokko) y tu forma de hablar. Responde, califica presupuesto y zona, y ofrece propiedades reales con precio y ficha.', dir: 'left' as Dir },
    { icon: ICONS.inbox, title: '3 canales, 1 bandeja', desc: 'WhatsApp, Instagram y Messenger entran al mismo lugar. Tu equipo interviene cuando quiere, la IA sigue cuando no.', dir: 'up' as Dir },
    { icon: ICONS.pin, title: 'Busca "cerca de X"', desc: '"¿Tenés algo cerca del Hospital Austral?" — la IA geolocaliza el punto y filtra propiedades por distancia real. Nadie más hace esto.', dir: 'right' as Dir },
    { icon: ICONS.kanban, title: 'Pipeline que se mueve solo', desc: 'Cada lead avanza de etapa automáticamente según la conversación: nuevo → calificado → visita. Kanban estilo Kommo, sin cargar datos a mano.', dir: 'left' as Dir },
    { icon: ICONS.calendar, title: 'Agenda visitas y recuerda', desc: 'La IA coordina día y horario, agenda la visita y manda recordatorios 24 h y 1 h antes. Menos ausencias, más recorridos.', dir: 'up' as Dir },
    { icon: ICONS.chart, title: 'Números que importan', desc: 'Leads por canal, tasa de calificación, tiempos de respuesta y embudo completo. Sabés qué campaña trae compradores y cuál trae curiosos.', dir: 'right' as Dir },
  ];

  return (
    <div style={{ background: CHARCOAL, color: TEXT, fontFamily: '"DM Sans", "Plus Jakarta Sans", sans-serif', overflowX: 'hidden' }}>
      <style>{`
        .lp-msg { animation: lpSlideIn 420ms ${EASE} both; }
        @keyframes lpSlideIn { from { opacity: 0; transform: translateY(14px) scale(0.97); } to { opacity: 1; transform: none; } }
        .lp-dot { width: 6px; height: 6px; border-radius: 50%; background: ${MUTED}; display: inline-block; animation: lpBounce 1s infinite; }
        @keyframes lpBounce { 0%, 60%, 100% { transform: translateY(0); opacity: .4 } 30% { transform: translateY(-4px); opacity: 1 } }
        .lp-pulse { animation: lpPulse 2s infinite; }
        @keyframes lpPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(37,211,102,0.5) } 50% { box-shadow: 0 0 0 5px rgba(37,211,102,0) } }
        .lp-float { animation: lpFloat 7s ease-in-out infinite; }
        @keyframes lpFloat { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-10px) } }
        .lp-btn:hover { transform: translateY(-2px); box-shadow: 0 14px 44px rgba(232,160,32,0.4); }
        .lp-btn:active { transform: scale(0.97); }
        .lp-card:hover { transform: translateY(-4px); border-color: rgba(232,160,32,0.3) !important; }
        .lp-grid-bg { background-image: linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px); background-size: 56px 56px; }
        @media (prefers-reduced-motion: reduce) {
          .lp-msg, .lp-pulse, .lp-float, .lp-dot { animation: none !important; }
        }
        @media (max-width: 900px) {
          .lp-hero { grid-template-columns: 1fr !important; }
          .lp-feats { grid-template-columns: 1fr !important; }
          .lp-stats { grid-template-columns: repeat(2, 1fr) !important; row-gap: 32px; }
          .lp-steps { grid-template-columns: 1fr !important; }
          .lp-testis { grid-template-columns: 1fr !important; }
        }
      `}</style>

      {/* ── Nav ── */}
      <nav style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 100,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px clamp(20px, 5vw, 56px)',
        background: scrolled ? 'rgba(12,14,18,0.85)' : 'transparent',
        backdropFilter: scrolled ? 'blur(14px)' : 'none',
        borderBottom: scrolled ? `1px solid ${BORDER}` : '1px solid transparent',
        transition: `background 300ms ${EASE}, border-color 300ms ${EASE}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
          <div style={{ width: 34, height: 34, borderRadius: 9, background: `linear-gradient(135deg, #F5B840, #C07818)`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: SYNE, fontWeight: 800, fontSize: 15, color: CHARCOAL }}>L</div>
          <span style={{ fontFamily: SYNE, fontWeight: 700, fontSize: 16.5 }}>LMTM CRM</span>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <button onClick={() => navigate('/login')} style={{ ...BTN_GHOST, padding: '10px 20px', fontSize: 14 }} className="lp-btn">Ingresar</button>
          <button onClick={() => navigate('/register')} style={{ ...BTN, padding: '10px 22px', fontSize: 14 }} className="lp-btn">Probar gratis</button>
        </div>
      </nav>

      {/* ── Hero ── */}
      <header className="lp-grid-bg" style={{ position: 'relative', minHeight: '100dvh', display: 'flex', alignItems: 'center', padding: '120px clamp(20px, 5vw, 56px) 72px' }}>
        <div style={{ position: 'absolute', top: '-15%', left: '-10%', width: 640, height: 640, borderRadius: '50%', background: 'radial-gradient(circle, rgba(232,160,32,0.10) 0%, transparent 62%)', pointerEvents: 'none' }} />
        <div style={{ position: 'absolute', bottom: '-20%', right: '-8%', width: 520, height: 520, borderRadius: '50%', background: 'radial-gradient(circle, rgba(37,211,102,0.06) 0%, transparent 65%)', pointerEvents: 'none' }} />

        <div className="lp-hero" style={{ display: 'grid', gridTemplateColumns: '1.1fr 0.9fr', gap: 'clamp(32px, 6vw, 80px)', alignItems: 'center', maxWidth: 1240, margin: '0 auto', width: '100%' }}>
          <div>
            <div style={{ ...reveal(heroIn, 0), display: 'inline-flex', alignItems: 'center', gap: 9, padding: '7px 14px', borderRadius: 999, border: `1px solid ${BORDER}`, background: 'rgba(255,255,255,0.03)', fontSize: 12.5, color: MUTED, marginBottom: 26 }}>
              <span style={{ display: 'inline-flex', gap: 5 }}>
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: GREEN }} />
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: IG }} />
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: MSN }} />
              </span>
              WhatsApp · Instagram · Messenger — con IA propia
            </div>

            <h1 style={{ ...reveal(heroIn, 90), fontFamily: DISPLAY, fontWeight: 800, fontSize: 'clamp(2.4rem, 5.2vw, 4rem)', lineHeight: 1.06, letterSpacing: '-0.02em', margin: 0 }}>
              Tu equipo duerme.<br />
              <span style={{ color: AMBER }}>Tu CRM no.</span>
            </h1>

            <p style={{ ...reveal(heroIn, 180), fontSize: 'clamp(1rem, 1.6vw, 1.15rem)', lineHeight: 1.75, color: MUTED, maxWidth: '54ch', margin: '24px 0 34px' }}>
              El CRM inmobiliario con IA que responde cada consulta en segundos, califica al comprador,
              le muestra propiedades reales de tu cartera y le agenda la visita. Vos entrás a la mañana
              y el lead ya está listo.
            </p>

            <div style={{ ...reveal(heroIn, 270), display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              <button onClick={() => navigate('/register')} style={BTN} className="lp-btn">
                Probar gratis <Icon d={ICONS.arrow} color={CHARCOAL} />
              </button>
              <button onClick={goDemo} style={BTN_GHOST} className="lp-btn">Ver cómo funciona</button>
            </div>

            <div style={{ ...reveal(heroIn, 360), display: 'flex', gap: 22, marginTop: 34, fontSize: 12.5, color: MUTED, flexWrap: 'wrap' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Icon d={ICONS.check} color={EMERALD} /> Sin tarjeta</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Icon d={ICONS.check} color={EMERALD} /> Integra Tokko Broker</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Icon d={ICONS.check} color={EMERALD} /> Listo en 15 minutos</span>
            </div>
          </div>

          <div className="lp-float" style={{ display: 'flex', justifyContent: 'center' }}>
            <ChatDemo />
          </div>
        </div>
      </header>

      {/* ── Stats count-up ── */}
      <section ref={stats.ref} style={{ padding: '76px clamp(20px, 5vw, 56px)', borderTop: `1px solid ${BORDER}`, borderBottom: `1px solid ${BORDER}`, background: SURFACE }}>
        <div className="lp-stats" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 20, maxWidth: 1100, margin: '0 auto' }}>
          <Stat value={7} suffix=" seg" label="respuesta promedio de la IA" visible={stats.visible} delay={0} />
          <Stat value={24} suffix="/7" label="atención sin francos ni feriados" visible={stats.visible} delay={100} />
          <Stat value={3} prefix="x" label="más leads calificados por mes" visible={stats.visible} delay={200} />
          <Stat value={100} suffix="%" label="de consultas respondidas" visible={stats.visible} delay={300} />
        </div>
      </section>

      {/* ── Features ── */}
      <section ref={feat.ref} style={{ padding: '110px clamp(20px, 5vw, 56px)', maxWidth: 1240, margin: '0 auto' }}>
        <div style={{ textAlign: 'center', marginBottom: 64, ...reveal(feat.visible) }}>
          <div style={{ fontFamily: MONO, fontSize: 12, color: AMBER, letterSpacing: 2, textTransform: 'uppercase', marginBottom: 14 }}>Todo el ciclo, automático</div>
          <h2 style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 'clamp(1.8rem, 3.6vw, 2.7rem)', letterSpacing: '-0.02em', margin: 0 }}>
            De "hola, ¿está disponible?"<br />a visita agendada. <span style={{ color: AMBER }}>Sin tocar nada.</span>
          </h2>
        </div>
        <div className="lp-feats" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 18 }}>
          {FEATURES.map((f, i) => (
            <div key={f.title} className="lp-card" style={{
              padding: '28px 26px', borderRadius: 16, background: SURFACE,
              border: `1px solid ${BORDER}`, transition: `transform 220ms ${EASE}, border-color 220ms ${EASE}`,
              ...reveal(feat.visible, 120 + i * 90, f.dir),
            }}>
              <div style={{ width: 46, height: 46, borderRadius: 12, background: AMBER_SOFT, border: `1px solid rgba(232,160,32,0.2)`, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 18 }}>
                <Icon d={f.icon} />
              </div>
              <h3 style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 17.5, margin: '0 0 10px' }}>{f.title}</h3>
              <p style={{ fontSize: 14, lineHeight: 1.7, color: MUTED, margin: 0 }}>{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Simulación Kanban ── */}
      <section id="demo-kanban" ref={kanban.ref} style={{ padding: '90px clamp(20px, 5vw, 56px)', background: SURFACE, borderTop: `1px solid ${BORDER}`, borderBottom: `1px solid ${BORDER}` }}>
        <div style={{ maxWidth: 1100, margin: '0 auto', display: 'grid', gridTemplateColumns: '1fr', gap: 44 }}>
          <div style={{ textAlign: 'center', ...reveal(kanban.visible) }}>
            <div style={{ fontFamily: MONO, fontSize: 12, color: AMBER, letterSpacing: 2, textTransform: 'uppercase', marginBottom: 14 }}>Mirá tu pipeline trabajar</div>
            <h2 style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 'clamp(1.7rem, 3.2vw, 2.4rem)', letterSpacing: '-0.02em', margin: '0 0 12px' }}>
              Cada conversación mueve el lead <span style={{ color: AMBER }}>por sí sola</span>
            </h2>
            <p style={{ color: MUTED, fontSize: 15, maxWidth: '58ch', margin: '0 auto', lineHeight: 1.7 }}>
              La IA puntúa a cada contacto según lo que dice — presupuesto, zona, urgencia — y lo avanza
              de etapa en el tablero. Tu embudo se ordena solo, en tiempo real.
            </p>
          </div>
          <div style={{ maxWidth: 760, margin: '0 auto', width: '100%', ...reveal(kanban.visible, 200) }}>
            <KanbanDemo visible={kanban.visible} />
          </div>
        </div>
      </section>

      {/* ── Cómo funciona ── */}
      <section ref={how.ref} style={{ padding: '110px clamp(20px, 5vw, 56px)', maxWidth: 1100, margin: '0 auto' }}>
        <div style={{ textAlign: 'center', marginBottom: 60, ...reveal(how.visible) }}>
          <h2 style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 'clamp(1.8rem, 3.4vw, 2.5rem)', letterSpacing: '-0.02em', margin: 0 }}>
            Funcionando <span style={{ color: AMBER }}>hoy mismo</span>
          </h2>
        </div>
        <div className="lp-steps" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20 }}>
          {[
            { n: '01', t: 'Conectá tus canales', d: 'WhatsApp, Instagram y Messenger en un par de clics con la conexión asistida de Meta. Sin developers.' },
            { n: '02', t: 'Entrená tu asistente', d: 'Elegí una plantilla, ajustá el tono, conectá tu cartera de Tokko y probalo en el simulador antes de salir en vivo.' },
            { n: '03', t: 'Mirá entrar los leads', d: 'La IA atiende, el pipeline se ordena, la agenda se llena. Vos y tu equipo cierran las ventas.' },
          ].map((s, i) => (
            <div key={s.n} style={{ position: 'relative', padding: '30px 26px', borderRadius: 16, background: SURFACE, border: `1px solid ${BORDER}`, ...reveal(how.visible, 120 + i * 130, i === 0 ? 'left' : i === 2 ? 'right' : 'up') }}>
              <div style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color: AMBER, marginBottom: 14 }}>{s.n}</div>
              <h3 style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 17, margin: '0 0 10px' }}>{s.t}</h3>
              <p style={{ fontSize: 14, lineHeight: 1.7, color: MUTED, margin: 0 }}>{s.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Testimonios ── */}
      <section ref={testi.ref} style={{ padding: '90px clamp(20px, 5vw, 56px)', background: SURFACE, borderTop: `1px solid ${BORDER}`, borderBottom: `1px solid ${BORDER}` }}>
        <div className="lp-testis" style={{ maxWidth: 1100, margin: '0 auto', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
          {[
            { q: 'Antes perdíamos las consultas del fin de semana. Ahora el lunes tengo visitas agendadas que la IA coordinó sola el sábado a la noche.', a: 'Inmobiliaria en Rosario', dir: 'left' as Dir },
            { q: 'El tablero se ordena solo. Abro el CRM y ya sé a quién llamar primero: el que tiene score alto y visita pedida.', a: 'Equipo comercial, zona norte GBA', dir: 'right' as Dir },
          ].map((t) => (
            <div key={t.a} style={{ padding: '30px 28px', borderRadius: 16, background: CHARCOAL, border: `1px solid ${BORDER}`, ...reveal(testi.visible, 100, t.dir) }}>
              <div style={{ color: AMBER, fontSize: 22, fontFamily: DISPLAY, lineHeight: 1, marginBottom: 14 }}>&ldquo;</div>
              <p style={{ fontSize: 15.5, lineHeight: 1.75, color: TEXT, margin: '0 0 18px' }}>{t.q}</p>
              <div style={{ fontSize: 12.5, fontFamily: MONO, color: MUTED }}>— {t.a}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── CTA final ── */}
      <section ref={cta.ref} style={{ padding: '130px clamp(20px, 5vw, 56px)', textAlign: 'center', position: 'relative', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: 760, height: 760, borderRadius: '50%', background: 'radial-gradient(circle, rgba(232,160,32,0.09) 0%, transparent 60%)', pointerEvents: 'none' }} />
        <div style={{ position: 'relative', ...reveal(cta.visible) }}>
          <h2 style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 'clamp(2rem, 4.4vw, 3.2rem)', letterSpacing: '-0.02em', margin: '0 0 18px', lineHeight: 1.1 }}>
            La próxima consulta que entre,<br /><span style={{ color: AMBER }}>respondela con IA.</span>
          </h2>
          <p style={{ color: MUTED, fontSize: 16, margin: '0 0 36px' }}>Configuralo en 15 minutos. Sin tarjeta de crédito.</p>
          <button onClick={() => navigate('/register')} style={{ ...BTN, padding: '17px 38px', fontSize: 16.5 }} className="lp-btn">
            Crear mi cuenta gratis <Icon d={ICONS.arrow} color={CHARCOAL} />
          </button>
          <div style={{ marginTop: 22, fontSize: 12.5, color: MUTED, display: 'flex', justifyContent: 'center', gap: 8, alignItems: 'center' }}>
            <Icon d={ICONS.shield} color={EMERALD} /> Tus datos cifrados · 2FA disponible · Multi-tenant aislado
          </div>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer style={{ padding: '36px clamp(20px, 5vw, 56px)', borderTop: `1px solid ${BORDER}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 26, height: 26, borderRadius: 7, background: `linear-gradient(135deg, #F5B840, #C07818)`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: SYNE, fontWeight: 800, fontSize: 12, color: CHARCOAL }}>L</div>
          <span style={{ fontSize: 13, color: MUTED }}>© 2026 LMTM CRM · crm.lmtmas.com</span>
        </div>
        <div style={{ display: 'flex', gap: 20, fontSize: 13 }}>
          <a href="/login" style={{ color: MUTED, textDecoration: 'none' }}>Ingresar</a>
          <a href="/register" style={{ color: AMBER, textDecoration: 'none', fontWeight: 600 }}>Crear cuenta</a>
        </div>
      </footer>
    </div>
  );
}
