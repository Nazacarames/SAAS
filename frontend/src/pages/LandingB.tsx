import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

const AMBER = '#E8A020';
const CHARCOAL = '#0C0E12';
const SURFACE = '#13161C';
const SURFACE2 = '#1A1D24';
const BORDER = 'rgba(232, 160, 32, 0.12)';
const BORDER_SOFT = 'rgba(232, 230, 225, 0.08)';
const TEXT = '#E8E6E1';
const MUTED = '#7A7872';
const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';

function useScrollReveal(threshold = 0.12) {
  const ref = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) { setVisible(true); obs.disconnect(); }
      },
      { threshold }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [threshold]);
  return { ref, visible };
}

function reveal(visible: boolean, delay = 0): React.CSSProperties {
  return {
    opacity: visible ? 1 : 0,
    transform: visible ? 'translateY(0) scale(1)' : 'translateY(20px) scale(0.95)',
    transition: `opacity 600ms ${EASE_OUT} ${delay}ms, transform 600ms ${EASE_OUT} ${delay}ms`,
  };
}

const BTN_PRIMARY: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '8px',
  padding: '14px 28px',
  background: AMBER,
  color: CHARCOAL,
  border: 'none',
  borderRadius: '8px',
  fontFamily: 'DM Sans, sans-serif',
  fontWeight: 700,
  fontSize: '15px',
  cursor: 'pointer',
  letterSpacing: '0.01em',
  transition: `transform 160ms ${EASE_OUT}, box-shadow 200ms ${EASE_OUT}`,
};

const BTN_GHOST: React.CSSProperties = {
  ...BTN_PRIMARY,
  background: 'transparent',
  color: TEXT,
  border: `1px solid ${BORDER_SOFT}`,
};

export default function LandingB() {
  const navigate = useNavigate();
  const [scrolled, setScrolled] = useState(false);
  const [heroVisible, setHeroVisible] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setHeroVisible(true), 80);
    const onScroll = () => setScrolled(window.scrollY > 48);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { clearTimeout(t); window.removeEventListener('scroll', onScroll); };
  }, []);

  const logos = useScrollReveal();
  const features = useScrollReveal();
  const how = useScrollReveal();
  const testimonial = useScrollReveal();
  const cta = useScrollReveal();

  return (
    <div style={{ background: CHARCOAL, color: TEXT, fontFamily: 'DM Sans, sans-serif', minHeight: '100dvh', overflowX: 'hidden' }}>
      <style>{`
        .lnd-btn-p { transition: transform 160ms ${EASE_OUT}, box-shadow 200ms ${EASE_OUT} !important; }
        .lnd-btn-p:hover { box-shadow: 0 0 28px rgba(232,160,32,0.35) !important; }
        .lnd-btn-p:active { transform: scale(0.97) !important; }
        .lnd-btn-g:active { transform: scale(0.97) !important; }
        .lnd-btn-g { transition: border-color 200ms, color 200ms !important; }
        .lnd-btn-g:hover { border-color: rgba(232,230,225,0.3) !important; color: #E8E6E1 !important; }
        .nav-a { color: #7A7872; text-decoration: none; font-size: 14px; transition: color 200ms; }
        .nav-a:hover { color: #E8E6E1; }
        .fc { transition: border-color 300ms ${EASE_OUT}, transform 300ms ${EASE_OUT}; }
        .fc:hover { border-color: rgba(232,160,32,0.35) !important; transform: translateY(-3px); }
        @keyframes pulseDot { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        @keyframes shimmerSlide { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
      `}</style>

      {/* NAV */}
      <nav style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 200,
        height: '64px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 48px',
        background: scrolled ? `rgba(12,14,18,0.88)` : 'transparent',
        backdropFilter: scrolled ? 'blur(14px)' : 'none',
        borderBottom: scrolled ? `1px solid ${BORDER}` : '1px solid transparent',
        transition: `background 400ms ${EASE_OUT}, backdrop-filter 400ms ${EASE_OUT}, border-color 400ms ${EASE_OUT}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{
            width: '30px', height: '30px',
            background: AMBER, borderRadius: '7px',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
              <path d="M12 2C6.48 2 2 6.48 2 12c0 1.85.5 3.58 1.37 5.07L2 22l5.05-1.35A9.945 9.945 0 0012 22c5.52 0 10-4.48 10-10S17.52 2 12 2z" fill={CHARCOAL}/>
            </svg>
          </div>
          <span style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '17px', letterSpacing: '-0.025em', color: TEXT }}>
            LMTM CRM
          </span>
        </div>

        <div style={{ display: 'flex', gap: '32px' }}>
          <a href="#features" className="nav-a">Funciones</a>
          <a href="#how" className="nav-a">Cómo funciona</a>
          <a href="#testimonial" className="nav-a">Clientes</a>
        </div>

        <div style={{ display: 'flex', gap: '10px' }}>
          <button className="lnd-btn-g" style={BTN_GHOST} onClick={() => navigate('/login')}>
            Iniciar sesión
          </button>
          <button className="lnd-btn-p" style={BTN_PRIMARY} onClick={() => navigate('/register')}>
            Empezar gratis
          </button>
        </div>
      </nav>

      {/* HERO — split layout, left content / right visual */}
      <section style={{
        minHeight: '100dvh',
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        alignItems: 'center',
        gap: '64px',
        padding: '80px 48px 48px',
        maxWidth: '1400px',
        margin: '0 auto',
      }}>
        {/* Left */}
        <div>
          <div style={{
            ...reveal(heroVisible, 0),
            display: 'inline-flex', alignItems: 'center', gap: '8px',
            padding: '5px 12px 5px 8px',
            background: 'rgba(232,160,32,0.08)',
            border: `1px solid ${BORDER}`,
            borderRadius: '100px',
            marginBottom: '28px',
          }}>
            <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: AMBER, animation: 'pulseDot 2s ease-in-out infinite' }} />
            <span style={{ fontSize: '11px', color: AMBER, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', fontFamily: 'DM Sans, sans-serif' }}>
              CRM Omnicanal con IA
            </span>
          </div>

          <h1 style={{
            ...reveal(heroVisible, 80),
            fontFamily: 'Syne, sans-serif',
            fontSize: 'clamp(42px, 5vw, 68px)',
            fontWeight: 800,
            lineHeight: 1.04,
            letterSpacing: '-0.035em',
            margin: '0 0 22px',
            color: TEXT,
          }}>
            Convierte chats<br />
            en <span style={{ color: AMBER }}>ventas reales</span>
          </h1>

          <p style={{
            ...reveal(heroVisible, 160),
            fontSize: '17px',
            lineHeight: 1.65,
            color: MUTED,
            margin: '0 0 36px',
            maxWidth: '420px',
          }}>
            WhatsApp, Instagram y Messenger en una sola bandeja. La IA atiende, califica leads y cierra más negocios por vos.
          </p>

          {/* Channel chips */}
          <div style={{ ...reveal(heroVisible, 200), display: 'flex', gap: '10px', marginBottom: '36px', flexWrap: 'wrap' }}>
            {[
              { label: 'WhatsApp', color: '#25D366', letter: 'W' },
              { label: 'Instagram', color: '#E1306C', letter: 'I' },
              { label: 'Messenger', color: '#0084FF', letter: 'M' },
            ].map((c) => (
              <div key={c.label} style={{
                display: 'inline-flex', alignItems: 'center', gap: '8px',
                padding: '7px 13px 7px 9px', borderRadius: '10px',
                background: `${c.color}14`, border: `1px solid ${c.color}30`,
              }}>
                <span style={{
                  width: '18px', height: '18px', borderRadius: '50%', background: c.color,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  fontFamily: 'Syne, sans-serif', fontWeight: 800, fontSize: '9px', color: '#fff',
                }}>{c.letter}</span>
                <span style={{ fontSize: '13px', fontWeight: 600, color: TEXT, fontFamily: 'DM Sans, sans-serif' }}>{c.label}</span>
              </div>
            ))}
          </div>

          <div style={{ ...reveal(heroVisible, 240), display: 'flex', gap: '12px' }}>
            <button
              className="lnd-btn-p"
              style={{ ...BTN_PRIMARY, padding: '16px 32px', fontSize: '15px' }}
              onClick={() => navigate('/register')}
            >
              Comenzar gratis
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
            <button className="lnd-btn-g" style={{ ...BTN_GHOST, padding: '16px 28px', fontSize: '15px' }}>
              Ver demo
            </button>
          </div>

          <div style={{ ...reveal(heroVisible, 320), display: 'flex', alignItems: 'center', gap: '14px', marginTop: '44px' }}>
            <div style={{ display: 'flex' }}>
              {['#4A8FD4', '#D45A4A', '#4AB87A', '#8A6AD4'].map((c, i) => (
                <div key={i} style={{
                  width: '30px', height: '30px', borderRadius: '50%',
                  background: c, border: `2px solid ${CHARCOAL}`,
                  marginLeft: i ? '-9px' : 0,
                }} />
              ))}
            </div>
            <p style={{ margin: 0, fontSize: '13px', color: MUTED }}>
              <strong style={{ color: TEXT }}>+200 equipos</strong> ya confían en nosotros
            </p>
          </div>
        </div>

        {/* Right: App mockup */}
        <div style={{ ...reveal(heroVisible, 100), position: 'relative' }}>
          <div style={{
            background: SURFACE,
            borderRadius: '18px',
            border: `1px solid ${BORDER}`,
            overflow: 'hidden',
            boxShadow: `0 48px 96px rgba(0,0,0,0.55), 0 0 0 1px rgba(232,160,32,0.06)`,
          }}>
            {/* Window chrome */}
            <div style={{
              padding: '12px 16px',
              background: 'rgba(255,255,255,0.02)',
              borderBottom: `1px solid ${BORDER}`,
              display: 'flex', alignItems: 'center', gap: '7px',
            }}>
              {['#FF5F57', '#FEBC2E', '#28C840'].map((c, i) => (
                <div key={i} style={{ width: '11px', height: '11px', borderRadius: '50%', background: c }} />
              ))}
              <div style={{ flex: 1 }} />
              <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '10px', color: MUTED }}>
                LMTM CRM
              </span>
            </div>

            {/* App UI */}
            <div style={{ display: 'grid', gridTemplateColumns: '190px 1fr', height: '320px' }}>
              {/* Sidebar */}
              <div style={{ borderRight: `1px solid ${BORDER}`, padding: '10px', overflowY: 'auto' }}>
                <p style={{ margin: '0 0 8px 4px', fontSize: '9px', color: MUTED, fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                  Conversaciones
                </p>
                {[
                  { name: 'María García', msg: 'Quiero info del depto...', active: true, ch: '#25D366', chl: 'W' },
                  { name: 'Carlos López', msg: '¿Cuándo podemos ver?', active: false, ch: '#E1306C', chl: 'I' },
                  { name: 'Ana Martínez', msg: 'Perfecto, confirmado', active: false, ch: '#0084FF', chl: 'M' },
                  { name: 'Rodrigo Sosa', msg: 'Mandame la propuesta', active: false, ch: '#25D366', chl: 'W' },
                ].map((c, i) => (
                  <div key={i} style={{
                    padding: '8px',
                    borderRadius: '8px',
                    marginBottom: '3px',
                    background: c.active ? 'rgba(232,160,32,0.1)' : 'transparent',
                    display: 'flex', gap: '8px',
                    cursor: 'default',
                  }}>
                    <div style={{ position: 'relative', flexShrink: 0 }}>
                      <div style={{
                        width: '30px', height: '30px', borderRadius: '50%',
                        background: `hsl(${i * 77 + 160}, 35%, 38%)`,
                      }} />
                      <div style={{
                        position: 'absolute', bottom: '-2px', right: '-2px',
                        width: '13px', height: '13px', borderRadius: '50%',
                        background: c.ch, border: `2px solid ${SURFACE}`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontFamily: 'Syne, sans-serif', fontWeight: 800, fontSize: '6px', color: '#fff',
                      }}>{c.chl}</div>
                    </div>
                    <div style={{ overflow: 'hidden', minWidth: 0 }}>
                      <p style={{ margin: 0, fontSize: '11px', fontWeight: 600, color: c.active ? AMBER : TEXT, fontFamily: 'DM Sans, sans-serif', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</p>
                      <p style={{ margin: 0, fontSize: '10px', color: MUTED, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.msg}</p>
                    </div>
                  </div>
                ))}
              </div>

              {/* Chat */}
              <div style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{
                  alignSelf: 'flex-start',
                  background: 'rgba(255,255,255,0.06)',
                  borderRadius: '12px 12px 12px 3px',
                  padding: '9px 13px',
                  maxWidth: '78%',
                }}>
                  <p style={{ margin: 0, fontSize: '11px', color: TEXT, lineHeight: 1.5 }}>
                    Hola! Me interesa el departamento de 3 ambientes en Palermo, ¿sigue disponible?
                  </p>
                </div>
                <div style={{
                  alignSelf: 'flex-end',
                  background: 'rgba(232,160,32,0.14)',
                  borderRadius: '12px 12px 3px 12px',
                  padding: '9px 13px',
                  maxWidth: '78%',
                }}>
                  <p style={{ margin: 0, fontSize: '11px', color: TEXT, lineHeight: 1.5 }}>
                    Sí, está disponible. Puedo coordinar una visita esta semana. ¿Te viene el jueves?
                  </p>
                </div>
                <div style={{
                  alignSelf: 'flex-start',
                  background: 'rgba(255,255,255,0.06)',
                  borderRadius: '12px 12px 12px 3px',
                  padding: '9px 13px',
                  maxWidth: '78%',
                }}>
                  <p style={{ margin: 0, fontSize: '11px', color: TEXT }}>Perfecto, el jueves a las 17hs me viene bien.</p>
                </div>

                {/* AI reply bar */}
                <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px', background: 'rgba(255,255,255,0.03)', borderRadius: '8px', border: `1px solid ${BORDER}` }}>
                  <div style={{ width: '14px', height: '14px', borderRadius: '50%', background: 'rgba(232,160,32,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: AMBER }} />
                  </div>
                  <span style={{ fontSize: '10px', color: MUTED, fontFamily: 'JetBrains Mono, monospace' }}>Sugerir respuesta con IA...</span>
                </div>
              </div>
            </div>
          </div>

          {/* Ambient glow */}
          <div style={{
            position: 'absolute',
            inset: '-60px',
            background: `radial-gradient(ellipse at 50% 50%, rgba(232,160,32,0.07) 0%, transparent 65%)`,
            zIndex: -1,
            pointerEvents: 'none',
          }} />
        </div>
      </section>

      {/* LOGOS STRIP */}
      <div ref={logos.ref as any} style={{ borderTop: `1px solid ${BORDER_SOFT}`, borderBottom: `1px solid ${BORDER_SOFT}` }}>
        <div style={{ maxWidth: '1400px', margin: '0 auto', padding: '40px 48px' }}>
          <p style={{
            ...reveal(logos.visible, 0),
            textAlign: 'center',
            fontSize: '11px', color: MUTED,
            letterSpacing: '0.12em', textTransform: 'uppercase',
            fontFamily: 'JetBrains Mono, monospace',
            marginBottom: '24px',
          }}>
            Utilizado por equipos de ventas en toda la región
          </p>
          <div style={{ ...reveal(logos.visible, 80), display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '52px', flexWrap: 'wrap' }}>
            {['Grupo Inmobiliario', 'PropTech BA', 'Remax Pro', 'Century 21', 'SuCasa Digital'].map((name, i) => (
              <span key={i} style={{ fontFamily: 'Syne, sans-serif', fontSize: '13px', fontWeight: 700, color: MUTED, letterSpacing: '-0.01em', opacity: 0.55 }}>
                {name}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* FEATURES — asymmetric bento, NOT identical card grid */}
      <section id="features" ref={features.ref as any} style={{ padding: '96px 48px' }}>
        <div style={{ maxWidth: '1400px', margin: '0 auto' }}>
          <div style={{ ...reveal(features.visible, 0), marginBottom: '56px', maxWidth: '560px' }}>
            <h2 style={{
              fontFamily: 'Syne, sans-serif',
              fontSize: 'clamp(30px, 3.5vw, 50px)',
              fontWeight: 800,
              letterSpacing: '-0.03em',
              lineHeight: 1.08,
              color: TEXT,
              margin: '0 0 14px',
            }}>
              Todo en un panel.<br />Nada se te escapa.
            </h2>
            <p style={{ fontSize: '16px', color: MUTED, lineHeight: 1.65 }}>
              Desde el primer mensaje hasta el contrato firmado, cada paso del proceso organizado y visible.
            </p>
          </div>

          {/* Bento: 1 large (span 2) + 1 tall + 2 small */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gridTemplateRows: 'auto auto', gap: '14px' }}>

            {/* Large card — spans 2 cols */}
            <div className="fc" style={{
              gridColumn: '1 / 3',
              ...reveal(features.visible, 80),
              background: SURFACE,
              borderRadius: '16px',
              border: `1px solid ${BORDER}`,
              padding: '40px',
              position: 'relative',
              overflow: 'hidden',
            }}>
              <div style={{ position: 'absolute', top: '-30px', right: '-30px', width: '200px', height: '200px', background: `radial-gradient(circle, rgba(232,160,32,0.09) 0%, transparent 70%)`, pointerEvents: 'none' }} />
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '20px' }}>
                <div style={{ width: '52px', height: '52px', background: 'rgba(232,160,32,0.1)', borderRadius: '14px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
                    <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" stroke={AMBER} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
                <div>
                  <h3 style={{ fontFamily: 'Syne, sans-serif', fontSize: '22px', fontWeight: 700, color: TEXT, margin: '0 0 10px', letterSpacing: '-0.025em' }}>
                    Bandeja unificada omnicanal
                  </h3>
                  <p style={{ fontSize: '15px', color: MUTED, lineHeight: 1.65, maxWidth: '520px', margin: 0 }}>
                    WhatsApp, Instagram y Messenger de todo tu equipo en una sola pantalla. Asigna conversaciones, añade notas internas y etiqueta por etapa de venta. Nunca vuelvas a perder un lead, sin importar por qué canal escriba.
                  </p>
                </div>
              </div>
            </div>

            {/* Tall card — spans 2 rows */}
            <div className="fc" style={{
              gridColumn: '3',
              gridRow: '1 / 3',
              ...reveal(features.visible, 160),
              background: SURFACE,
              borderRadius: '16px',
              border: `1px solid ${BORDER}`,
              padding: '36px',
              display: 'flex',
              flexDirection: 'column',
            }}>
              <div style={{ width: '44px', height: '44px', background: 'rgba(232,160,32,0.1)', borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '18px' }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                  <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke={AMBER} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <h3 style={{ fontFamily: 'Syne, sans-serif', fontSize: '20px', fontWeight: 700, color: TEXT, margin: '0 0 10px', letterSpacing: '-0.025em' }}>
                Pipeline visual
              </h3>
              <p style={{ fontSize: '14px', color: MUTED, lineHeight: 1.65, margin: '0 0 28px' }}>
                Arrastra leads entre etapas. Visualiza tu embudo de ventas y actúa en el momento exacto.
              </p>
              <div style={{ marginTop: 'auto' }}>
                {['Nuevo contacto', 'Calificado', 'Propuesta enviada', 'Cierre'].map((stage, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '11px 0', borderTop: `1px solid ${BORDER_SOFT}` }}>
                    <div style={{
                      width: '8px', height: '8px', borderRadius: '50%',
                      background: i === 3 ? '#4AB87A' : AMBER,
                      opacity: 1 - i * 0.18,
                    }} />
                    <span style={{ fontSize: '13px', color: i === 3 ? TEXT : MUTED, fontFamily: 'DM Sans, sans-serif', flex: 1 }}>{stage}</span>
                    <span style={{ fontSize: '10px', fontFamily: 'JetBrains Mono, monospace', color: AMBER }}>
                      {[14, 9, 5, 3][i]}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Small card 1 */}
            <div className="fc" style={{
              ...reveal(features.visible, 240),
              background: SURFACE,
              borderRadius: '16px',
              border: `1px solid ${BORDER}`,
              padding: '32px',
            }}>
              <div style={{ width: '40px', height: '40px', background: 'rgba(232,160,32,0.1)', borderRadius: '11px', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '16px' }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke={AMBER} strokeWidth="1.5"/>
                  <path d="M12 8v4l3 3" stroke={AMBER} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <h3 style={{ fontFamily: 'Syne, sans-serif', fontSize: '17px', fontWeight: 700, color: TEXT, margin: '0 0 8px', letterSpacing: '-0.02em' }}>
                IA en cada canal
              </h3>
              <p style={{ fontSize: '13px', color: MUTED, lineHeight: 1.6, margin: 0 }}>
                Atiende fuera de horario, califica leads y agenda citas en WhatsApp, Instagram y Messenger por igual.
              </p>
            </div>

            {/* Small card 2 */}
            <div className="fc" style={{
              ...reveal(features.visible, 320),
              background: SURFACE,
              borderRadius: '16px',
              border: `1px solid ${BORDER}`,
              padding: '32px',
            }}>
              <div style={{ width: '40px', height: '40px', background: 'rgba(232,160,32,0.1)', borderRadius: '11px', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '16px' }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <rect x="3" y="4" width="18" height="18" rx="2" stroke={AMBER} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  <line x1="16" y1="2" x2="16" y2="6" stroke={AMBER} strokeWidth="1.5" strokeLinecap="round"/>
                  <line x1="8" y1="2" x2="8" y2="6" stroke={AMBER} strokeWidth="1.5" strokeLinecap="round"/>
                  <line x1="3" y1="10" x2="21" y2="10" stroke={AMBER} strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              </div>
              <h3 style={{ fontFamily: 'Syne, sans-serif', fontSize: '17px', fontWeight: 700, color: TEXT, margin: '0 0 8px', letterSpacing: '-0.02em' }}>
                Agenda integrada
              </h3>
              <p style={{ fontSize: '13px', color: MUTED, lineHeight: 1.6, margin: 0 }}>
                Coordina visitas y reuniones directamente desde el chat, sin apps externas.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section id="how" ref={how.ref as any} style={{ padding: '96px 48px', borderTop: `1px solid ${BORDER_SOFT}` }}>
        <div style={{ maxWidth: '1400px', margin: '0 auto' }}>
          <div style={{ ...reveal(how.visible, 0), marginBottom: '64px' }}>
            <h2 style={{ fontFamily: 'Syne, sans-serif', fontSize: 'clamp(30px, 3.5vw, 50px)', fontWeight: 800, letterSpacing: '-0.03em', color: TEXT, margin: '0 0 14px', lineHeight: 1.08 }}>
              En marcha en minutos
            </h2>
            <p style={{ fontSize: '16px', color: MUTED, maxWidth: '380px', lineHeight: 1.65 }}>
              Sin migraciones complejas. Tu equipo opera desde el primer día.
            </p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '40px' }}>
            {[
              { n: '01', title: 'Conecta tus canales', desc: 'Vinculá WhatsApp, Instagram y Messenger en minutos. Sin instalar nada.' },
              { n: '02', title: 'Invita tu equipo', desc: 'Agrega vendedores y asigna roles con permisos por agente.' },
              { n: '03', title: 'Importa tus leads', desc: 'Sube tu base de contactos o conecta tus anuncios de Meta Ads.' },
              { n: '04', title: 'Empieza a vender', desc: 'Gestiona todas las conversaciones desde un panel central y mide resultados.' },
            ].map((step, i) => (
              <div key={i} style={{ ...reveal(how.visible, i * 90) }}>
                <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '11px', color: AMBER, letterSpacing: '0.1em', fontWeight: 600 }}>
                  {step.n}
                </span>
                <div style={{ width: '1px', height: '28px', background: BORDER, margin: '10px 0' }} />
                <h3 style={{ fontFamily: 'Syne, sans-serif', fontSize: '17px', fontWeight: 700, color: TEXT, margin: '0 0 8px', letterSpacing: '-0.02em' }}>
                  {step.title}
                </h3>
                <p style={{ fontSize: '14px', color: MUTED, lineHeight: 1.65, margin: 0 }}>
                  {step.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* TESTIMONIAL */}
      <section id="testimonial" ref={testimonial.ref as any} style={{ padding: '96px 48px', background: SURFACE2 }}>
        <div style={{ maxWidth: '820px', margin: '0 auto', textAlign: 'center', ...reveal(testimonial.visible, 0) }}>
          <svg width="36" height="28" viewBox="0 0 36 28" fill="none" style={{ marginBottom: '28px', opacity: 0.35 }}>
            <path d="M0 28V16.5C0 6.5 5.9 1.6 17.7 0v5.2C12 6 9.1 8.5 9.1 13H14.5V28H0zm18.3 0V16.5C18.3 6.5 24.2 1.6 36 0v5.2C30.3 6 27.4 8.5 27.4 13H32.8V28H18.3z" fill={AMBER}/>
          </svg>
          <p style={{
            fontFamily: 'Syne, sans-serif',
            fontSize: 'clamp(19px, 2.2vw, 26px)',
            fontWeight: 600,
            color: TEXT,
            lineHeight: 1.45,
            letterSpacing: '-0.02em',
            margin: '0 0 32px',
          }}>
            Antes perdíamos leads por no poder responder a tiempo. Con LMTM CRM triplicamos la tasa de respuesta y cerramos un 40% más de operaciones en 3 meses.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '14px' }}>
            <div style={{ width: '42px', height: '42px', borderRadius: '50%', background: 'linear-gradient(135deg, #4A8FD4 0%, #E8A020 100%)' }} />
            <div style={{ textAlign: 'left' }}>
              <p style={{ margin: 0, fontSize: '14px', fontWeight: 600, color: TEXT, fontFamily: 'DM Sans, sans-serif' }}>
                Sebastián Ruiz
              </p>
              <p style={{ margin: 0, fontSize: '13px', color: MUTED }}>
                Director, Grupo Inmobiliario Norte
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section ref={cta.ref as any} style={{ padding: '120px 48px' }}>
        <div style={{ maxWidth: '680px', margin: '0 auto', textAlign: 'center', ...reveal(cta.visible, 0) }}>
          <h2 style={{
            fontFamily: 'Syne, sans-serif',
            fontSize: 'clamp(34px, 4vw, 58px)',
            fontWeight: 800,
            letterSpacing: '-0.03em',
            color: TEXT,
            margin: '0 0 18px',
            lineHeight: 1.05,
          }}>
            Tu próxima venta<br />empieza en un chat
          </h2>
          <p style={{ fontSize: '17px', color: MUTED, margin: '0 0 36px', lineHeight: 1.65 }}>
            14 días gratis, sin tarjeta de crédito. Cancela cuando quieras.
          </p>
          <button
            className="lnd-btn-p"
            style={{ ...BTN_PRIMARY, padding: '18px 40px', fontSize: '16px' }}
            onClick={() => navigate('/register')}
          >
            Crear cuenta gratuita
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
              <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>
      </section>

      {/* FOOTER */}
      <footer style={{ padding: '40px 48px', borderTop: `1px solid ${BORDER_SOFT}` }}>
        <div style={{ maxWidth: '1400px', margin: '0 auto', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ width: '26px', height: '26px', background: AMBER, borderRadius: '6px' }} />
            <span style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '15px', color: TEXT }}>LMTM CRM</span>
          </div>
          <span style={{ fontSize: '13px', color: MUTED }}>
            © 2026 LMTM CRM. Todos los derechos reservados.
          </span>
          <div style={{ display: 'flex', gap: '24px' }}>
            <a href="#" className="nav-a">Privacidad</a>
            <a href="#" className="nav-a">Términos</a>
            <a href="#" className="nav-a">Contacto</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
