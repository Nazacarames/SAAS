import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  Chip,
  Container,
  Divider,
  Grid,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Paper,
  Stack,
  Typography
} from '@mui/material';
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded';
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded';
import AutoAwesomeRoundedIcon from '@mui/icons-material/AutoAwesomeRounded';
import HubRoundedIcon from '@mui/icons-material/HubRounded';
import InsightsRoundedIcon from '@mui/icons-material/InsightsRounded';
import BoltRoundedIcon from '@mui/icons-material/BoltRounded';
import WhatsAppIcon from '@mui/icons-material/WhatsApp';
import StarRoundedIcon from '@mui/icons-material/StarRounded';
import { useNavigate } from 'react-router-dom';

const FEATURES = [
  {
    icon: <AutoAwesomeRoundedIcon sx={{ color: '#7DD3FC' }} />,
    title: 'IA comercial con control real',
    description:
      'Automatiza respuestas, clasifica intención, puntúa leads y deriva a humano cuando hace falta. Recaptura en unos días todo lo que se fuga en la atención.'
  },
  {
    icon: <HubRoundedIcon sx={{ color: '#7DD3FC' }} />,
    title: 'Tablero de control visual y accionable',
    description:
      'Pipeline visual y accionable: seguimiento por etapa, visibilidad de cuellos de botella y foco diario en oportunidades calientes.'
  },
  {
    icon: <InsightsRoundedIcon sx={{ color: '#7DD3FC' }} />,
    title: 'Métricas y control operativo',
    description:
      'Volumen de consultas por canal, derivaciones comerciales por agente, tiempos de respuesta, performance de equipo y alertas para escalar sin perder calidad.'
  },
  {
    icon: <WhatsAppIcon sx={{ color: '#7DD3FC' }} />,
    title: 'Integración profesional',
    description: 'WhatsApp Cloud API, Meta Leads, templates y webhooks listos para una operación seria.'
  }
];

const PLANS = [
  {
    name: 'Starter',
    price: 'USD 39',
    period: '/mes',
    description: 'Para equipos que inician su operación comercial por WhatsApp.',
    cta: 'Empezar prueba gratis',
    highlight: false,
    bullets: ['1 número WhatsApp', '2 agentes', '1 bot IA', '1.000 conversaciones/mes']
  },
  {
    name: 'Pro',
    price: 'USD 89',
    period: '/mes',
    description: 'El más elegido para escalar ventas con control.',
    cta: 'Probar 14 días gratis',
    highlight: true,
    bullets: ['5 agentes', 'IA avanzada + guardrails', 'Meta + webhooks', '5.000 conversaciones/mes']
  },
  {
    name: 'Scale',
    price: 'A medida',
    period: '',
    description: 'Para alto volumen, multi-equipo o necesidades enterprise.',
    cta: 'Hablar con especialista',
    highlight: false,
    bullets: ['Multi número / multi equipo', 'SLA prioritario', 'CSM dedicado', 'Integraciones custom']
  }
];

const SERVICES = [
  {
    title: 'Implementación Express (7 días)',
    desc: 'Configuración inicial, embudo, agentes y automatizaciones para salir a producción rápido.'
  },
  {
    title: 'Entrenamiento IA para tu negocio',
    desc: 'Entrenamos el bot con FAQs, objeciones y tono comercial de tu empresa.'
  },
  {
    title: 'Optimización mensual de conversión',
    desc: 'Ajustes continuos sobre atención, scripts y embudo para mejorar resultados mes a mes.'
  },
  {
    title: 'Auditoría comercial y de atención',
    desc: 'Diagnóstico de fuga de leads, tiempos de respuesta y calidad operativa del equipo.'
  }
];

const FAQ = [
  {
    q: '¿Cómo funciona la prueba gratis?',
    a: 'Activás tu cuenta, conectás canales y empezás a operar sin permanencia. Podés pasar a pago cuando quieras.'
  },
  {
    q: '¿Necesito equipo técnico para implementarlo?',
    a: 'No. El onboarding está guiado y el setup base es rápido. Si necesitás, te acompañamos en la configuración.'
  },
  {
    q: '¿Puedo escalar con mi equipo comercial actual?',
    a: 'Sí. Charlott está pensado para operar con agentes humanos + IA, con control de desempeño por etapa y canal.'
  }
];

const Landing = () => {
  const navigate = useNavigate();

  return (
    <Box
      sx={{
        minHeight: '100vh',
        color: '#fff',
        background:
          'radial-gradient(circle at 20% 8%, rgba(56,189,248,.25), transparent 34%), radial-gradient(circle at 85% 0%, rgba(14,165,233,.16), transparent 28%), linear-gradient(180deg, #040915 0%, #030712 100%)',
        py: { xs: 3, md: 5 }
      }}
    >
      <Container maxWidth='lg'>
        <Paper
          sx={{
            p: 1.2,
            mb: { xs: 5, md: 7 },
            borderRadius: 99,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            border: '1px solid rgba(125,211,252,.3)',
            bgcolor: 'rgba(2, 12, 32, .65)',
            backdropFilter: 'blur(8px)',
            position: 'sticky',
            top: 10,
            zIndex: 10
          }}
        >
          <Stack direction='row' spacing={1} alignItems='center' sx={{ pl: 1 }}>
            <StarRoundedIcon sx={{ color: '#7DD3FC', fontSize: 20 }} />
            <Typography sx={{ fontWeight: 800 }}>Charlott CRM</Typography>
          </Stack>
          <Stack direction='row' spacing={1}>
            <Button size='small' variant='text' sx={{ color: '#E2E8F0' }} onClick={() => navigate('/login')}>
              Login
            </Button>
            <Button
              size='small'
              variant='contained'
              onClick={() => navigate('/register')}
              sx={{ fontWeight: 700, background: 'linear-gradient(90deg,#3B82F6,#06B6D4)' }}
            >
              Prueba gratis
            </Button>
          </Stack>
        </Paper>

        <Stack spacing={3} sx={{ textAlign: 'center', mb: { xs: 6, md: 8 } }}>
          <Stack direction='row' justifyContent='center'>
            <Chip
              label='Atención + Ventas + IA en un solo tablero'
              sx={{ bgcolor: 'rgba(125,211,252,.15)', color: '#BAE6FD', border: '1px solid rgba(125,211,252,.35)' }}
            />
          </Stack>

          <Typography variant='h2' sx={{ fontWeight: 900, fontSize: { xs: '2rem', md: '3.5rem' }, lineHeight: 1.05 }}>
            Atendé y vendé 24/7
            <br />
            con Charlott CRM
          </Typography>

          <Typography sx={{ color: 'rgba(226,232,240,.9)', maxWidth: 900, mx: 'auto', fontSize: { xs: '1rem', md: '1.2rem' } }}>
            Todo centralizado en un panel de control. Incorporá un bot entrenado con IA para tu negocio y dominá las consultas con métricas que te permiten tomar mejores decisiones.
          </Typography>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} justifyContent='center'>
            <Button
              size='large'
              variant='contained'
              startIcon={<BoltRoundedIcon />}
              onClick={() => navigate('/register')}
              sx={{ px: 3, py: 1.2, fontWeight: 800, background: 'linear-gradient(90deg,#3B82F6,#06B6D4)' }}
            >
              Empezar prueba gratis
            </Button>
            <Button
              size='large'
              variant='outlined'
              onClick={() => navigate('/register')}
              sx={{ color: '#fff', borderColor: 'rgba(255,255,255,.35)', px: 3, py: 1.2 }}
            >
              Hablar con especialista
            </Button>
          </Stack>
        </Stack>

        <Grid container spacing={2.2} sx={{ mb: { xs: 6, md: 8 } }}>
          {FEATURES.map((item) => (
            <Grid item xs={12} md={6} key={item.title}>
              <Paper
                sx={{
                  p: 2.2,
                  height: '100%',
                  borderRadius: 3,
                  border: '1px solid rgba(125,211,252,.2)',
                  background: 'linear-gradient(180deg, rgba(2,12,32,.82), rgba(2,12,32,.55))'
                }}
              >
                <Stack direction='row' spacing={1.2} alignItems='flex-start'>
                  <Box sx={{ mt: 0.2 }}>{item.icon}</Box>
                  <Box>
                    <Typography variant='h6' sx={{ fontWeight: 700, mb: 0.5 }}>
                      {item.title}
                    </Typography>
                    <Typography variant='body2' sx={{ color: 'rgba(226,232,240,.82)' }}>
                      {item.description}
                    </Typography>
                  </Box>
                </Stack>
              </Paper>
            </Grid>
          ))}
        </Grid>

        <Paper sx={{ mb: 7, p: { xs: 2.2, md: 3 }, borderRadius: 3, border: '1px solid rgba(125,211,252,.28)', background: 'rgba(2,12,32,.8)' }}>
          <Typography variant='h5' sx={{ fontWeight: 800, mb: 1 }}>Cómo funciona</Typography>
          <Grid container spacing={2}>
            {[
              ['1. Conectás canales', 'WhatsApp Cloud, Meta leads y fuentes de contacto.'],
              ['2. Definís operación', 'Tablero, equipo, reglas de derivación y automatizaciones.'],
              ['3. Escalás con datos', 'Métricas, alertas y optimización continua de conversión.']
            ].map(([t, d]) => (
              <Grid item xs={12} md={4} key={t}>
                <Typography sx={{ fontWeight: 700, mb: 0.4 }}>{t}</Typography>
                <Typography variant='body2' sx={{ color: 'rgba(226,232,240,.8)' }}>{d}</Typography>
              </Grid>
            ))}
          </Grid>
        </Paper>

        <Typography variant='h4' sx={{ fontWeight: 900, textAlign: 'center', mb: 1 }}>Planes y prueba gratis</Typography>
        <Typography sx={{ textAlign: 'center', color: 'rgba(226,232,240,.82)', mb: 3.2 }}>
          Elegí tu plan y activá tu operación comercial hoy.
        </Typography>

        <Grid container spacing={2.2} sx={{ mb: 4 }}>
          {PLANS.map((plan) => (
            <Grid item xs={12} md={4} key={plan.name}>
              <Paper
                sx={{
                  p: 2.2,
                  height: '100%',
                  borderRadius: 3,
                  border: plan.highlight ? '1px solid rgba(14,165,233,.9)' : '1px solid rgba(148,163,184,.35)',
                  background: plan.highlight ? 'linear-gradient(180deg, rgba(8,33,72,.95), rgba(3,13,34,.98))' : 'rgba(2,12,32,.7)',
                  boxShadow: plan.highlight ? '0 0 0 1px rgba(14,165,233,.35),0 16px 34px rgba(14,165,233,.2)' : 'none'
                }}
              >
                <Stack spacing={1.2}>
                  <Stack direction='row' justifyContent='space-between' alignItems='center'>
                    <Typography variant='h6' sx={{ fontWeight: 800 }}>{plan.name}</Typography>
                    {plan.highlight && <Chip label='Recomendado' size='small' sx={{ bgcolor: '#0284C7', color: '#fff', fontWeight: 700 }} />}
                  </Stack>
                  <Typography variant='h4' sx={{ fontWeight: 900 }}>
                    {plan.price}
                    <Typography component='span' sx={{ fontSize: '.95rem', color: 'rgba(226,232,240,.72)', ml: 0.6 }}>{plan.period}</Typography>
                  </Typography>
                  <Typography variant='body2' sx={{ color: 'rgba(226,232,240,.82)' }}>{plan.description}</Typography>
                  <Divider sx={{ borderColor: 'rgba(148,163,184,.28)' }} />
                  <List dense disablePadding>
                    {plan.bullets.map((bullet) => (
                      <ListItem key={bullet} sx={{ px: 0 }}>
                        <ListItemIcon sx={{ minWidth: 28 }}><CheckCircleRoundedIcon sx={{ color: '#22C55E', fontSize: 18 }} /></ListItemIcon>
                        <ListItemText primary={bullet} primaryTypographyProps={{ sx: { color: 'rgba(226,232,240,.9)', fontSize: '.92rem' } }} />
                      </ListItem>
                    ))}
                  </List>
                  <Button fullWidth variant={plan.highlight ? 'contained' : 'outlined'} onClick={() => navigate('/register')} sx={{ mt: 0.8, fontWeight: 700, color: '#fff', borderColor: 'rgba(148,163,184,.5)', background: plan.highlight ? 'linear-gradient(90deg,#3B82F6,#0EA5E9)' : 'transparent' }}>
                    {plan.cta}
                  </Button>
                </Stack>
              </Paper>
            </Grid>
          ))}
        </Grid>

        <Paper sx={{ p: 2.2, mb: 6, borderRadius: 3, border: '1px solid rgba(125,211,252,.22)', background: 'rgba(2,12,32,.65)' }}>
          <Typography variant='h6' sx={{ fontWeight: 800, mb: 1.4 }}>Comparativa rápida</Typography>
          <Grid container spacing={1.2}>
            {[
              'Agentes incluidos por plan',
              'Conversaciones mensuales incluidas',
              'Bots IA y reglas de derivación',
              'Integraciones (Meta, webhooks, API)',
              'Soporte y SLA'
            ].map((item) => (
              <Grid item xs={12} md={6} key={item}>
                <Stack direction='row' spacing={1} alignItems='center'>
                  <CheckCircleRoundedIcon sx={{ color: '#22C55E', fontSize: 18 }} />
                  <Typography variant='body2' sx={{ color: 'rgba(226,232,240,.85)' }}>{item}</Typography>
                </Stack>
              </Grid>
            ))}
          </Grid>
          <Stack direction='row' spacing={1} useFlexGap flexWrap='wrap' sx={{ mt: 2 }}>
            {['Agente extra', 'Conversaciones extra', 'Número extra', 'Soporte premium'].map((addon) => (
              <Chip key={addon} label={`Add-on: ${addon}`} variant='outlined' sx={{ borderColor: 'rgba(125,211,252,.4)', color: '#BAE6FD' }} />
            ))}
          </Stack>
        </Paper>

        <Paper sx={{ p: { xs: 2.2, md: 3 }, mb: 6, borderRadius: 3, border: '1px solid rgba(125,211,252,.22)', background: 'rgba(2,12,32,.7)' }}>
          <Typography variant='h5' sx={{ fontWeight: 800, mb: 1 }}>Servicios profesionales</Typography>
          <Typography sx={{ color: 'rgba(226,232,240,.82)', mb: 2 }}>Además del software, te ayudamos a implementar y mejorar resultados.</Typography>
          <Grid container spacing={2}>
            {SERVICES.map((service) => (
              <Grid item xs={12} md={6} key={service.title}>
                <Paper sx={{ p: 1.6, borderRadius: 2, border: '1px solid rgba(148,163,184,.25)', background: 'rgba(2,12,32,.55)' }}>
                  <Typography sx={{ fontWeight: 700, mb: 0.4 }}>{service.title}</Typography>
                  <Typography variant='body2' sx={{ color: 'rgba(226,232,240,.8)' }}>{service.desc}</Typography>
                </Paper>
              </Grid>
            ))}
          </Grid>
        </Paper>

        <Paper sx={{ p: 2.2, mb: 6, borderRadius: 3, border: '1px solid rgba(14,165,233,.35)', background: 'linear-gradient(90deg, rgba(2,132,199,.18), rgba(30,41,59,.55))' }}>
          <Typography variant='h6' sx={{ fontWeight: 800 }}>Impacto estimado (ROI orientativo)</Typography>
          <Typography sx={{ color: 'rgba(226,232,240,.85)', mt: 0.8 }}>
            Si hoy perdés 20 leads/mes por demora en respuesta, con automatización + recaptura podrías recuperar entre 25% y 45% en los primeros 60 días.
          </Typography>
        </Paper>

        <Paper sx={{ p: { xs: 2, md: 3 }, mb: 6, borderRadius: 3, border: '1px solid rgba(125,211,252,.22)', background: 'rgba(2,12,32,.7)' }}>
          <Typography variant='h5' sx={{ fontWeight: 800, mb: 1.5 }}>Preguntas frecuentes</Typography>
          {FAQ.map((item) => (
            <Accordion key={item.q} sx={{ bgcolor: 'transparent', color: '#E2E8F0', boxShadow: 'none' }}>
              <AccordionSummary expandIcon={<ExpandMoreRoundedIcon sx={{ color: '#BAE6FD' }} />}>
                <Typography sx={{ fontWeight: 600 }}>{item.q}</Typography>
              </AccordionSummary>
              <AccordionDetails>
                <Typography variant='body2' sx={{ color: 'rgba(226,232,240,.82)' }}>{item.a}</Typography>
              </AccordionDetails>
            </Accordion>
          ))}
        </Paper>

        <Paper sx={{ p: { xs: 2.2, md: 3 }, borderRadius: 3, textAlign: 'center', border: '1px solid rgba(14,165,233,.45)', background: 'linear-gradient(90deg, rgba(2,132,199,.22), rgba(30,41,59,.65))' }}>
          <Typography variant='h5' sx={{ fontWeight: 900, mb: 1 }}>Activá tu operación comercial premium</Typography>
          <Typography sx={{ color: 'rgba(226,232,240,.85)', mb: 2 }}>Empezá con prueba gratis o coordiná una llamada con especialista.</Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.2} justifyContent='center'>
            <Button size='large' variant='contained' onClick={() => navigate('/register')} sx={{ fontWeight: 800, px: 4, background: 'linear-gradient(90deg,#3B82F6,#06B6D4)' }}>
              Crear cuenta gratis
            </Button>
            <Button size='large' variant='outlined' onClick={() => navigate('/register')} sx={{ color: '#fff', borderColor: 'rgba(255,255,255,.45)' }}>
              Hablar con especialista
            </Button>
          </Stack>
        </Paper>
      </Container>
    </Box>
  );
};

export default Landing;
