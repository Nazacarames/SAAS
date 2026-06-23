import {
  Drawer, List, ListItem, ListItemButton, ListItemIcon, ListItemText,
  Typography, Box, Divider, Avatar, Stack, Tooltip
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

const drawerWidth = 224;

const menuItems = [
  { text: 'Dashboard',       icon: <DashboardIcon />,   path: '/',              section: 'main' },
  { text: 'Conversaciones',  icon: <ChatIcon />,        path: '/conversations', section: 'main' },
  { text: 'Leads',           icon: <ContactsIcon />,    path: '/leads',         section: 'main' },
  { text: 'Agenda',          icon: <CalendarMonthIcon />, path: '/agenda',      section: 'main' },
  { text: 'Canales',         icon: <WhatsAppIcon />,    path: '/connections',   section: 'main' },
  { text: 'Reportes',        icon: <AnalyticsIcon />,   path: '/reports',       section: 'ops', adminOnly: true },
  { text: 'Billing',         icon: <CreditCardIcon />,  path: '/billing',       section: 'ops' },
  { text: 'Agente IA',       icon: <SmartToyIcon />,    path: '/ai-agents',     section: 'config', adminOnly: true },
  { text: 'Conocimiento',    icon: <AutoStoriesIcon />, path: '/knowledge',     section: 'config', adminOnly: true },
  { text: 'Templates',       icon: <TextSnippetIcon />, path: '/templates',     section: 'config', adminOnly: true },
  { text: 'Usuarios',        icon: <PeopleIcon />,      path: '/users',         section: 'config', adminOnly: true },
  { text: 'Integraciones',   icon: <SettingsIcon />,    path: '/integrations',  section: 'config', adminOnly: true },
  { text: 'Configuracion',   icon: <SettingsIcon />,    path: '/settings',      section: 'config', adminOnly: true }
];

const SectionLabel = ({ children }: { children: React.ReactNode }) => (
  <Typography
    variant="overline"
    sx={{
      px: 2.5,
      pt: 2,
      pb: 0.5,
      display: 'block',
      fontSize: '0.65rem',
      letterSpacing: 1.4,
      color: 'rgba(255,255,255,0.28)',
      fontFamily: '"Syne", sans-serif',
      fontWeight: 600
    }}
  >
    {children}
  </Typography>
);

const Sidebar = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { handleLogout, user } = useAuth();
  const isAdmin = user?.profile === 'admin';

  const visible = menuItems.filter((i: any) => isAdmin || !i.adminOnly);
  const mainItems   = visible.filter(i => i.section === 'main');
  const opsItems    = visible.filter(i => i.section === 'ops');
  const configItems = visible.filter(i => i.section === 'config');

  const isActive = (path: string) =>
    path === '/' ? location.pathname === '/' : location.pathname.startsWith(path);

  const NavItem = ({ item }: { item: typeof menuItems[0] }) => {
    const active = isActive(item.path);
    return (
      <ListItem disablePadding>
        <ListItemButton
          selected={active}
          onClick={() => navigate(item.path)}
          sx={{ overflow: 'visible' }}
        >
          {active && (
            <Box
              sx={{
                position: 'absolute',
                left: -8,
                top: '50%',
                transform: 'translateY(-50%)',
                width: 3,
                height: 22,
                borderRadius: '0 3px 3px 0',
                background: 'linear-gradient(180deg, #F5B840 0%, #E8A020 100%)',
                boxShadow: '0 0 8px rgba(232,160,32,0.6)'
              }}
            />
          )}
          <ListItemIcon sx={{ color: active ? '#F5B840' : undefined }}>{item.icon}</ListItemIcon>
          <ListItemText primary={item.text} />
        </ListItemButton>
      </ListItem>
    );
  };

  const initials = (name?: string) =>
    (name || 'U').split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();

  const drawer = (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Brand */}
      <Box sx={{ px: 2.5, py: 2.5, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <Stack direction="row" alignItems="center" spacing={1.5}>
          <Box
            sx={{
              width: 32,
              height: 32,
              borderRadius: '9px',
              background: 'linear-gradient(135deg, #F5B840 0%, #C07818 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0
            }}
          >
            <Typography sx={{ fontFamily: '"Syne", sans-serif', fontWeight: 800, fontSize: '0.85rem', color: '#0C0E12', lineHeight: 1 }}>
              C
            </Typography>
          </Box>
          <Box>
            <Typography sx={{ fontFamily: '"Syne", sans-serif', fontWeight: 700, fontSize: '0.95rem', color: '#E8EBF2', lineHeight: 1.2 }}>
              LMTM
            </Typography>
            <Typography sx={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.35)', fontWeight: 500 }}>
              CRM
            </Typography>
          </Box>
        </Stack>
      </Box>

      {/* Nav */}
      <Box sx={{ flexGrow: 1, overflowY: 'auto', py: 1 }}>
        {mainItems.length > 0 && (
          <>
            <SectionLabel>Principal</SectionLabel>
            <List sx={{ py: 0.5 }}>
              {mainItems.map(item => <NavItem key={item.path} item={item} />)}
            </List>
          </>
        )}
        {opsItems.length > 0 && (
          <>
            <Divider sx={{ mx: 2, my: 1 }} />
            <SectionLabel>Operaciones</SectionLabel>
            <List sx={{ py: 0.5 }}>
              {opsItems.map(item => <NavItem key={item.path} item={item} />)}
            </List>
          </>
        )}
        {configItems.length > 0 && (
          <>
            <Divider sx={{ mx: 2, my: 1 }} />
            <SectionLabel>Configuracion</SectionLabel>
            <List sx={{ py: 0.5 }}>
              {configItems.map(item => <NavItem key={item.path} item={item} />)}
            </List>
          </>
        )}
      </Box>

      {/* User */}
      <Box sx={{ borderTop: '1px solid rgba(255,255,255,0.06)', p: 1.5 }}>
        <Stack direction="row" alignItems="center" spacing={1.5} sx={{ px: 1 }}>
          <Avatar sx={{ width: 30, height: 30, fontSize: '0.7rem', background: 'rgba(232,160,32,0.20)', color: '#E8A020', border: '1px solid rgba(232,160,32,0.30)' }}>
            {initials(user?.name)}
          </Avatar>
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <Typography sx={{ fontSize: '0.8rem', fontWeight: 600, color: '#E8EBF2', lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user?.name || 'Usuario'}
            </Typography>
            <Typography sx={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.35)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user?.profile || 'user'}
            </Typography>
          </Box>
          <Tooltip title="Cerrar sesion" placement="right">
            <Box
              onClick={handleLogout}
              sx={{
                cursor: 'pointer',
                color: 'rgba(255,255,255,0.30)',
                display: 'flex',
                alignItems: 'center',
                transition: 'color 160ms ease',
                '&:hover': { color: '#F87171' }
              }}
            >
              <LogoutIcon sx={{ fontSize: '1rem' }} />
            </Box>
          </Tooltip>
        </Stack>
      </Box>
    </Box>
  );

  return (
    <Box component="nav" sx={{ width: { sm: drawerWidth }, flexShrink: { sm: 0 } }}>
      <Drawer
        variant="permanent"
        sx={{
          display: { xs: 'none', sm: 'block' },
          '& .MuiDrawer-paper': { boxSizing: 'border-box', width: drawerWidth, overflow: 'hidden' }
        }}
        open
      >
        {drawer}
      </Drawer>
    </Box>
  );
};

export default Sidebar;
