import { useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Box, Toolbar, AppBar, Typography, Stack, IconButton } from '@mui/material';
import MenuIcon from '@mui/icons-material/Menu';
import Sidebar from '../components/Sidebar';
import HealthAlert from '../components/HealthAlert';
import TrialBanner from '../components/TrialBanner';

const drawerWidth = 224;

// Título de la sección: en el celular el menú está cerrado, así que sin esto
// no hay forma de saber en qué pantalla estás.
const TITULOS: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/conversations': 'Conversaciones',
  '/contacts': 'Leads',
  '/pipeline': 'Pipeline',
  '/agenda': 'Agenda',
  '/connections': 'Canales',
  '/reports': 'Reportes',
  '/ai-agents': 'Agente IA',
  '/knowledge': 'Conocimiento',
  '/templates': 'Templates',
  '/comment-automations': 'Comentarios',
  '/menu-bot': 'Menú Bot',
  '/users': 'Usuarios',
  '/integrations': 'Integraciones',
  '/security': 'Seguridad',
  '/settings': 'Configuración',
};

const MainLayout = () => {
  const [menuAbierto, setMenuAbierto] = useState(false);
  const { pathname } = useLocation();
  const titulo = TITULOS[pathname] || 'LMTM CRM';

  return (
    <Box sx={{ display: 'flex', minHeight: '100dvh', background: '#0C0E12' }}>
      <AppBar
        position="fixed"
        elevation={0}
        sx={{
          zIndex: (theme) => theme.zIndex.drawer + 1,
          width: { sm: `calc(100% - ${drawerWidth}px)` },
          ml: { sm: `${drawerWidth}px` }
        }}
      >
        <Toolbar sx={{ minHeight: '52px !important', px: { xs: 1, sm: 3 }, display: 'flex', justifyContent: 'space-between', gap: 1 }}>
          <Stack direction="row" spacing={0.5} alignItems="center" sx={{ minWidth: 0 }}>
            <IconButton
              onClick={() => setMenuAbierto(true)}
              aria-label="Abrir menú"
              sx={{ display: { sm: 'none' }, color: '#E8EBF2', p: 1 }}
            >
              <MenuIcon />
            </IconButton>
            <Typography noWrap sx={{ fontWeight: 700, fontSize: '0.875rem', color: '#E8EBF2', fontFamily: '"Syne", sans-serif' }}>
              {titulo}
            </Typography>
          </Stack>
          <Stack direction="row" spacing={1} alignItems="center">
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, px: 1.25, py: 0.5, borderRadius: '6px', border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.03)' }}>
              <Box className="live-dot" />
              <Typography sx={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.45)', fontFamily: 'var(--font-mono)', letterSpacing: 0.5 }}>
                live
              </Typography>
            </Box>
          </Stack>
        </Toolbar>
      </AppBar>

      <Sidebar mobileOpen={menuAbierto} onClose={() => setMenuAbierto(false)} />

      <Box
        component="main"
        sx={{
          flexGrow: 1,
          // sin minWidth:0 una tabla ancha estira el flex y toda la pantalla
          // se desplaza en horizontal
          minWidth: 0,
          width: { xs: '100%', sm: `calc(100% - ${drawerWidth}px)` },
          minHeight: '100dvh',
          background: '#0C0E12'
        }}
      >
        <Toolbar sx={{ minHeight: '52px !important' }} />
        <HealthAlert />
        <Box sx={{ p: { xs: 1.5, md: 3 }, maxWidth: 1400, width: '100%' }} className="page-enter">
          <TrialBanner />
          <Outlet />
        </Box>
      </Box>
    </Box>
  );
};

export default MainLayout;
