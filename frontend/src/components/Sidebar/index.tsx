import {
  Drawer,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Toolbar,
  Typography,
  Box,
  Divider,
  Chip
} from '@mui/material';
import {
  Dashboard as DashboardIcon,
  Chat as ChatIcon,
  Contacts as ContactsIcon,
  WhatsApp as WhatsAppIcon,
  People as PeopleIcon,
  Settings as SettingsIcon,
  SmartToy as SmartToyIcon,
  Logout as LogoutIcon,
  AutoStories as AutoStoriesIcon,
  CalendarMonth as CalendarMonthIcon,
  TextSnippet as TextSnippetIcon,
  Analytics as AnalyticsIcon,
  CreditCard as CreditCardIcon
} from '@mui/icons-material';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/Auth/AuthContext';

const drawerWidth = 240;

const Sidebar = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { handleLogout, user } = useAuth();
  const isAdmin = user?.profile === 'admin';

  const menuItems = [
    { text: 'Dashboard', icon: <DashboardIcon />, path: '/' },
    { text: 'Conversaciones', icon: <ChatIcon />, path: '/conversations' },
    { text: 'Leads', icon: <ContactsIcon />, path: '/leads' },
    { text: 'Agenda', icon: <CalendarMonthIcon />, path: '/agenda' },
    { text: 'WhatsApp', icon: <WhatsAppIcon />, path: '/connections' },
    { text: 'Reportes', icon: <AnalyticsIcon />, path: '/reports', adminOnly: true },
    { text: 'Billing', icon: <CreditCardIcon />, path: '/billing' },
    { text: 'Agente IA', icon: <SmartToyIcon />, path: '/ai-agents', adminOnly: true },
    { text: 'Conocimiento', icon: <AutoStoriesIcon />, path: '/knowledge', adminOnly: true },
    { text: 'Templates', icon: <TextSnippetIcon />, path: '/templates' },
    { text: 'Usuarios', icon: <PeopleIcon />, path: '/users', adminOnly: true },
    { text: 'Integraciones', icon: <SettingsIcon />, path: '/integrations', adminOnly: true },
    { text: 'Configuración', icon: <SettingsIcon />, path: '/settings', adminOnly: true }
  ];

  const drawer = (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Toolbar sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant='h6' noWrap component='div'>
          Charlott
        </Typography>
        <Chip label='CRM' size='small' color='primary' variant='outlined' />
      </Toolbar>
      <Divider />
      <List sx={{ py: 1 }}>
        {menuItems
          .filter((i: any) => isAdmin || !i.adminOnly)
          .map((item) => (
            <ListItem key={item.text} disablePadding>
              <ListItemButton selected={location.pathname === item.path} onClick={() => navigate(item.path)}>
                <ListItemIcon>{item.icon}</ListItemIcon>
                <ListItemText primary={item.text} />
              </ListItemButton>
            </ListItem>
          ))}
      </List>
      <Divider />
      <List>
        <ListItem disablePadding>
          <ListItemButton onClick={handleLogout}>
            <ListItemIcon>
              <LogoutIcon />
            </ListItemIcon>
            <ListItemText primary='Cerrar Sesión' />
          </ListItemButton>
        </ListItem>
      </List>
      <Box sx={{ p: 2, mt: 'auto' }}>
        <Typography variant='caption' color='text.secondary'>
          Usuario: {user?.name}
        </Typography>
      </Box>
    </Box>
  );

  return (
    <Box component='nav' sx={{ width: { sm: drawerWidth }, flexShrink: { sm: 0 } }}>
      <Drawer
        variant='permanent'
        sx={{
          display: { xs: 'none', sm: 'block' },
          '& .MuiDrawer-paper': { boxSizing: 'border-box', width: drawerWidth }
        }}
        open
      >
        {drawer}
      </Drawer>
    </Box>
  );
};

export default Sidebar;
