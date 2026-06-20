import { useState } from 'react';
import { Link } from 'react-router-dom';
import { TextField, Button, Typography, Box, Stack, CircularProgress, InputAdornment, IconButton } from '@mui/material';
import { Visibility, VisibilityOff } from '@mui/icons-material';
import { useAuth } from '../../context/Auth/AuthContext';
import { toast } from 'react-toastify';

const features = [
  { icon: '⚡', title: 'Respuestas instantaneas', desc: 'IA que atiende leads 24/7 en WhatsApp' },
  { icon: '📊', title: 'Funnel en tiempo real', desc: 'Metricas comerciales accionables' },
  { icon: '🔗', title: 'Meta Lead Ads', desc: 'Captura y calificacion automatica' },
];

const Login = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const { handleLogin } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await handleLogin(email, password);
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Credenciales incorrectas');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', background: '#0C0E12' }}>
      {/* Left brand panel */}
      <Box sx={{
        display: { xs: 'none', md: 'flex' },
        width: '44%',
        flexDirection: 'column',
        justifyContent: 'space-between',
        p: 5,
        background: '#0E1016',
        borderRight: '1px solid rgba(255,255,255,0.06)',
        position: 'relative',
        overflow: 'hidden'
      }}>
        <Box sx={{ position: 'absolute', top: -100, left: -100, width: 500, height: 500, borderRadius: '50%', background: 'radial-gradient(circle, rgba(232,160,32,0.07) 0%, transparent 65%)', pointerEvents: 'none' }} />
        <Box sx={{ position: 'absolute', bottom: -60, right: -60, width: 300, height: 300, borderRadius: '50%', background: 'radial-gradient(circle, rgba(52,211,153,0.05) 0%, transparent 70%)', pointerEvents: 'none' }} />

        {/* Logo */}
        <Stack direction="row" alignItems="center" spacing={1.5} className="anim-fade-up">
          <Box sx={{ width: 36, height: 36, borderRadius: '10px', background: 'linear-gradient(135deg, #F5B840 0%, #C07818 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Typography sx={{ fontFamily: '"Syne", sans-serif', fontWeight: 800, fontSize: '0.95rem', color: '#0C0E12' }}>C</Typography>
          </Box>
          <Typography sx={{ fontFamily: '"Syne", sans-serif', fontWeight: 700, fontSize: '1rem', color: '#E8EBF2' }}>Charlott</Typography>
        </Stack>

        {/* Hero copy */}
        <Box>
          <Typography className="anim-fade-up anim-fade-up-1" sx={{ fontFamily: '"Syne", sans-serif', fontWeight: 800, fontSize: { md: '1.9rem', lg: '2.3rem' }, color: '#E8EBF2', lineHeight: 1.2, mb: 1.5 }}>
            Tu operacion<br />
            <Box component="span" sx={{ color: '#E8A020' }}>WhatsApp</Box>
            <br />en un panel.
          </Typography>
          <Typography className="anim-fade-up anim-fade-up-2" sx={{ fontSize: '0.875rem', color: 'rgba(255,255,255,0.42)', lineHeight: 1.8, mb: 4 }}>
            CRM con IA para convertir conversaciones<br />en oportunidades reales de venta.
          </Typography>
          <Stack spacing={2.5}>
            {features.map((f, i) => (
              <Stack key={i} direction="row" spacing={1.5} alignItems="flex-start" className={'anim-fade-up anim-fade-up-' + (i + 3)}>
                <Box sx={{ width: 36, height: 36, borderRadius: '9px', background: 'rgba(232,160,32,0.10)', border: '1px solid rgba(232,160,32,0.18)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1rem', flexShrink: 0 }}>
                  {f.icon}
                </Box>
                <Box>
                  <Typography sx={{ fontSize: '0.84rem', fontWeight: 600, color: '#E8EBF2', mb: 0.2 }}>{f.title}</Typography>
                  <Typography sx={{ fontSize: '0.775rem', color: 'rgba(255,255,255,0.38)' }}>{f.desc}</Typography>
                </Box>
              </Stack>
            ))}
          </Stack>
        </Box>

        <Typography sx={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.18)' }}>
          2025 Charlott CRM
        </Typography>
      </Box>

      {/* Right form panel */}
      <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', p: { xs: 2.5, sm: 5 } }}>
        <Box sx={{ width: '100%', maxWidth: 380 }}>
          {/* Mobile logo */}
          <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 4, display: { md: 'none' } }}>
            <Box sx={{ width: 30, height: 30, borderRadius: '8px', background: 'linear-gradient(135deg, #F5B840 0%, #C07818 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Typography sx={{ fontFamily: '"Syne", sans-serif', fontWeight: 800, fontSize: '0.8rem', color: '#0C0E12' }}>C</Typography>
            </Box>
            <Typography sx={{ fontFamily: '"Syne", sans-serif', fontWeight: 700, color: '#E8EBF2', fontSize: '0.95rem' }}>Charlott CRM</Typography>
          </Stack>

          <Box className="anim-fade-up">
            <Typography sx={{ fontFamily: '"Syne", sans-serif', fontWeight: 700, fontSize: '1.55rem', color: '#E8EBF2', mb: 0.4 }}>Bienvenido</Typography>
            <Typography sx={{ fontSize: '0.875rem', color: 'rgba(255,255,255,0.38)', mb: 3.5 }}>Ingresa a tu panel de operaciones</Typography>
          </Box>

          <form onSubmit={handleSubmit}>
            <Stack spacing={2} className="anim-fade-up anim-fade-up-1">
              <TextField fullWidth label="Correo electronico" type="email" autoComplete="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} required />
              <TextField
                fullWidth
                label="Contrasena"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                InputProps={{
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton size="small" onClick={() => setShowPassword(!showPassword)} edge="end">
                        {showPassword ? <VisibilityOff fontSize="small" /> : <Visibility fontSize="small" />}
                      </IconButton>
                    </InputAdornment>
                  )
                }}
              />
              <Button type="submit" fullWidth variant="contained" size="large" disabled={loading} sx={{ mt: 0.5, py: 1.4, fontSize: '0.9rem', letterSpacing: 0.2 }}>
                {loading ? <CircularProgress size={20} sx={{ color: '#0C0E12' }} /> : 'Ingresar'}
              </Button>
            </Stack>
          </form>

          <Typography sx={{ textAlign: 'center', mt: 2, fontSize: '0.8rem' }}>
            <Link to="/forgot-password" style={{ color: 'rgba(255,255,255,0.38)', textDecoration: 'none' }}>Olvidé mi contraseña</Link>
          </Typography>

          <Typography sx={{ textAlign: 'center', mt: 1.5, color: 'rgba(255,255,255,0.32)', fontSize: '0.8rem' }}>
            No tenes cuenta?{' '}
            <Link to="/register" style={{ color: '#E8A020', textDecoration: 'none', fontWeight: 600 }}>Crear cuenta</Link>
          </Typography>
        </Box>
      </Box>
    </Box>
  );
};

export default Login;