import { Outlet } from 'react-router-dom';
import { Box, Toolbar, AppBar, Typography, Stack } from '@mui/material';
import Sidebar from '../components/Sidebar';
import HealthAlert from '../components/HealthAlert';

const drawerWidth = 224;

const MainLayout = () => {
  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', background: '#0C0E12' }}>
      <AppBar
        position="fixed"
        elevation={0}
        sx={{
          zIndex: (theme) => theme.zIndex.drawer + 1,
          width: { sm: `calc(100% - ${drawerWidth}px)` },
          ml: { sm: `${drawerWidth}px` }
        }}
      >
        <Toolbar sx={{ minHeight: '52px !important', px: { xs: 2, sm: 3 }, display: 'flex', justifyContent: 'space-between' }}>
          <Typography sx={{ fontWeight: 700, fontSize: '0.875rem', color: '#E8EBF2', fontFamily: '"Syne", sans-serif' }}>
            LMTM CRM
          </Typography>
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

      <Sidebar />

      <Box
        component="main"
        sx={{
          flexGrow: 1,
          width: { sm: `calc(100% - ${drawerWidth}px)` },
          minHeight: '100vh',
          background: '#0C0E12'
        }}
      >
        <Toolbar sx={{ minHeight: '52px !important' }} />
        <HealthAlert />
        <Box sx={{ p: { xs: 2, md: 3 }, maxWidth: 1400, width: "100%" }} className="page-enter">
          <Outlet />
        </Box>
      </Box>
    </Box>
  );
};

export default MainLayout;
