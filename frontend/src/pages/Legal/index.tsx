import { Link, useLocation } from 'react-router-dom';

const AMBER = '#E8A020';
const MUTED = 'rgba(232,235,242,0.55)';

const PRIVACIDAD = {
  title: 'Política de Privacidad',
  updated: 'Última actualización: julio 2026',
  sections: [
    ['Responsable', 'LMTM ("nosotros") opera la plataforma LMTM CRM en crm.lmtmas.com. Consultas sobre datos: grow@bylmtm.com.'],
    ['Qué datos tratamos', 'Datos de cuenta (nombre, email, empresa), datos operativos que cada empresa carga o recibe en su cuenta (contactos, conversaciones de WhatsApp/Instagram/Messenger, propiedades consultadas, citas) y métricas de uso de la plataforma.'],
    ['Para qué los usamos', 'Prestar el servicio (centralizar conversaciones, responder con IA, calificar leads, agendar visitas), facturación y soporte. No vendemos datos personales a terceros.'],
    ['Encargados de tratamiento', 'Para operar usamos proveedores: Meta (WhatsApp/Instagram/Messenger), OpenAI (procesamiento de mensajes para generar respuestas), MercadoPago (pagos), ARCA (facturación electrónica) e infraestructura de hosting. Cada proveedor procesa solo lo necesario para su función.'],
    ['Aislamiento y seguridad', 'Los datos de cada empresa están aislados por cuenta (multi-tenant). Credenciales y tokens se almacenan cifrados. Ofrecemos autenticación en dos pasos (2FA). Realizamos copias de seguridad diarias.'],
    ['Conservación y eliminación', 'Los datos se conservan mientras la cuenta esté activa. Podés solicitar la eliminación completa de tu cuenta y sus datos escribiendo a grow@bylmtm.com.'],
    ['Tus derechos', 'Acceso, rectificación y supresión de tus datos personales conforme a la Ley 25.326 de Protección de Datos Personales (Argentina). Ejercelos escribiendo a grow@bylmtm.com. También podés reclamar ante la Agencia de Acceso a la Información Pública.'],
  ],
};

const TERMINOS = {
  title: 'Términos y Condiciones',
  updated: 'Última actualización: julio 2026',
  sections: [
    ['El servicio', 'LMTM CRM es una plataforma de gestión de conversaciones y ventas con inteligencia artificial para empresas. Se contrata por suscripción mensual según el plan elegido, con un período de prueba gratuito de 30 días.'],
    ['Cuenta y uso aceptable', 'Sos responsable de la seguridad de tus credenciales y del contenido que tu empresa envía por la plataforma. No está permitido usar el servicio para spam, contenido ilegal o violar las políticas de Meta (WhatsApp Business, Instagram, Messenger).'],
    ['Planes, pagos y facturación', 'Los precios se publican en pesos argentinos y pueden actualizarse con aviso previo. Los pagos se procesan por MercadoPago y se emite factura electrónica. Si el pago no se concreta al vencer el período, el acceso al panel se suspende hasta regularizarlo; tus datos no se eliminan.'],
    ['Inteligencia artificial', 'Las respuestas automáticas se generan con modelos de IA a partir de la configuración y base de conocimiento de tu empresa. La IA puede cometer errores; el contenido enviado a tus clientes es responsabilidad de tu empresa, que puede supervisar e intervenir en cualquier conversación.'],
    ['Disponibilidad', 'Trabajamos para mantener el servicio disponible de forma continua, con monitoreo y backups diarios, pero no garantizamos disponibilidad ininterrumpida. Los servicios de terceros (Meta, OpenAI, MercadoPago) pueden afectar funciones específicas.'],
    ['Limitación de responsabilidad', 'El servicio se provee "como está". Nuestra responsabilidad total se limita al monto abonado en los últimos 3 meses de suscripción.'],
    ['Baja', 'Podés dar de baja tu suscripción en cualquier momento; el servicio continúa hasta el fin del período pagado. Podés solicitar la exportación o eliminación de tus datos a grow@bylmtm.com.'],
    ['Ley aplicable', 'Estos términos se rigen por las leyes de la República Argentina. Cualquier controversia se someterá a los tribunales ordinarios de la Ciudad de Rosario, Santa Fe.'],
  ],
};

const Legal = () => {
  const { pathname } = useLocation();
  const doc = pathname.includes('terminos') ? TERMINOS : PRIVACIDAD;

  return (
    <div style={{ minHeight: '100vh', background: '#0C0E12', color: '#E8EBF2', fontFamily: '"DM Sans", sans-serif' }}>
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '48px 24px 80px' }}>
        <Link to="/landing" style={{ color: MUTED, textDecoration: 'none', fontSize: 13.5 }}>← Volver a LMTM CRM</Link>
        <h1 style={{ fontFamily: '"Sora", sans-serif', fontWeight: 800, fontSize: 'clamp(1.7rem, 4vw, 2.4rem)', margin: '24px 0 6px' }}>
          {doc.title}
        </h1>
        <p style={{ fontSize: 13, color: MUTED, marginBottom: 36 }}>{doc.updated}</p>
        {doc.sections.map(([h, body], i) => (
          <section key={h} style={{ marginBottom: 28 }}>
            <h2 style={{ fontFamily: '"Sora", sans-serif', fontWeight: 700, fontSize: '1.05rem', color: AMBER, margin: '0 0 8px' }}>
              {i + 1}. {h}
            </h2>
            <p style={{ fontSize: 14.5, lineHeight: 1.85, color: 'rgba(232,235,242,0.75)', margin: 0 }}>{body}</p>
          </section>
        ))}
        <div style={{ marginTop: 44, paddingTop: 20, borderTop: '1px solid rgba(255,255,255,0.07)', display: 'flex', gap: 24, fontSize: 13.5 }}>
          <Link to="/privacidad" style={{ color: pathname.includes('privacidad') ? AMBER : MUTED, textDecoration: 'none' }}>Privacidad</Link>
          <Link to="/terminos" style={{ color: pathname.includes('terminos') ? AMBER : MUTED, textDecoration: 'none' }}>Términos</Link>
          <a href="mailto:grow@bylmtm.com" style={{ color: MUTED, textDecoration: 'none' }}>grow@bylmtm.com</a>
        </div>
      </div>
    </div>
  );
};

export default Legal;
