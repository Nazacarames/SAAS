import { Outlet } from 'react-router-dom';
import { Box, Toolbar, AppBar, Typography, Chip, Stack } from '@mui/material';
import Sidebar from '../components/Sidebar';

const MainLayout = () => {
  return (
    <Box sx={{ display: 'flex', minHeight: '100vh' }}>
      <AppBar
        position='fixed'
        sx={{ zIndex: (theme) => theme.zIndex.drawer + 1 }}
      >
        <Toolbar sx={{ display: 'flex', justifyContent: 'space-between' }}>
          <Stack direction='row' spacing={1.2} alignItems='center'>
            <Typography variant='h6' noWrap component='div' sx={{ fontWeight: 700 }}>
              Charlott CRM
            </Typography>
            <Chip size='small' label='WhatsApp Operations' color='primary' variant='outlined' />
          </Stack>
          <Typography variant='caption' color='text.secondary' sx={{ display: { xs: 'none', md: 'block' } }}>
            Panel profesional · tiempo real
          </Typography>
        </Toolbar>
      </AppBar>

      <Sidebar />

      <Box
        component='main'
        sx={{
          flexGrow: 1,
          p: { xs: 1.5, md: 3 },
          width: { sm: `calc(100% - 240px)` }
        }}
      >
        <Toolbar />
        <Outlet />
      </Box>
    </Box>
  );
};

export default MainLayout;
