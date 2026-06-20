import { useEffect, useState } from 'react';
import {
  Box, Typography, Stack, Button, LinearProgress, Chip, CircularProgress,
  Paper
} from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../services/api';

const PLAN_FEATURES: Record<string, string[]> = {
  starter: ['WhatsApp Cloud API', 'Meta Lead Ads', '1500 conversaciones/mes', '2 usuarios'],
  pro: ['Todo de Starter', 'IA con RAG + KB', 'Reportes avanzados', 'Agenda + Recordatorios', '6000 conversaciones/mes', '5 usuarios'],
  scale: ['Todo de Pro', 'API de acceso', '15000 conversaciones/mes', '10 usuarios'],
};

const PLAN_COLORS: Record<string, string> = {
  starter: '#4FC3F7',
  pro: '#E8A020',
  scale: '#34D399',
};

const formatPrice = (cents: number) => {
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 0 }).format(cents);
};

const UsageBar = ({ label, current, max }: { label: string; current: number; max: number }) => {
  const pct = max > 0 ? Math.min((current / max) * 100, 100) : 0;
  const isHigh = pct > 80;

  return (
    <Box sx={{ mb: 2 }}>
      <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.5 }}>
        <Typography sx={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.6)' }}>{label}</Typography>
        <Typography sx={{ fontSize: '0.8rem', color: isHigh ? '#EF5350' : 'rgba(255,255,255,0.5)', fontFamily: '"JetBrains Mono", monospace' }}>
          {current.toLocaleString()} / {max.toLocaleString()}
        </Typography>
      </Stack>
      <LinearProgress
        variant="determinate"
        value={pct}
        sx={{
          height: 6, borderRadius: 3,
          backgroundColor: 'rgba(255,255,255,0.06)',
          '& .MuiLinearProgress-bar': {
            borderRadius: 3,
            background: isHigh
              ? 'linear-gradient(90deg, #EF5350, #FF7043)'
              : 'linear-gradient(90deg, #E8A020, #F5B840)',
          },
        }}
      />
    </Box>
  );
};

const Billing = () => {
  const [data, setData] = useState<any>(null);
  const [plans, setPlans] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [checkoutLoading, setCheckoutLoading] = useState('');

  const load = async () => {
    try {
      const [currentRes, plansRes] = await Promise.all([
        api.get('/api/billing/current'),
        api.get('/api/billing/plans'),
      ]);
      setData(currentRes.data);
      setPlans(plansRes.data?.plans || []);
    } catch {
      toast.error('No se pudo cargar la información de billing');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleCheckout = async (planCode: string) => {
    setCheckoutLoading(planCode);
    try {
      const { data } = await api.post('/api/billing/checkout', { planCode });
      if (data?.checkoutUrl) {
        window.open(data.checkoutUrl, '_blank');
      } else {
        toast.success('Plan actualizado');
        await load();
      }
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'No se pudo procesar el pago');
    } finally {
      setCheckoutLoading('');
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 300 }}>
        <CircularProgress sx={{ color: '#E8A020' }} />
      </Box>
    );
  }

  const plan = data?.plan || {};
  const usage = data?.usage || {};
  const subscription = data?.subscription || {};
  const currentPlanCode = plan.plan_code || 'starter';
  const isTrialing = subscription.status === 'trialing';
  const trialEnd = subscription.trialEndsAt ? new Date(subscription.trialEndsAt) : null;
  const trialExpired = trialEnd ? trialEnd < new Date() : false;
  const isBypassed = subscription.billingBypass;

  return (
    <Box sx={{ maxWidth: 1100, mx: 'auto' }}>
      <Typography sx={{ fontFamily: '"Syne", sans-serif', fontWeight: 700, fontSize: '1.5rem', color: '#E8EBF2', mb: 0.5 }}>
        Billing
      </Typography>
      <Typography sx={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.4)', mb: 3 }}>
        Plan actual, uso del mes y opciones de upgrade
      </Typography>

      {/* Status Banner */}
      <Paper sx={{
        p: 2.5, mb: 3, borderRadius: '12px',
        background: trialExpired ? 'rgba(239,83,80,0.08)' : 'rgba(232,160,32,0.06)',
        border: `1px solid ${trialExpired ? 'rgba(239,83,80,0.2)' : 'rgba(232,160,32,0.12)'}`,
      }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1}>
          <Box>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
              <Typography sx={{ fontFamily: '"Syne", sans-serif', fontWeight: 700, fontSize: '1.1rem', color: '#E8EBF2' }}>
                Plan {plan.plan_code ? plan.plan_code.charAt(0).toUpperCase() + plan.plan_code.slice(1) : 'Starter'}
              </Typography>
              {isTrialing && (
                <Chip
                  label={trialExpired ? 'Trial expirado' : 'Trial activo'}
                  size="small"
                  sx={{
                    fontSize: '0.7rem', fontWeight: 600, height: 22,
                    backgroundColor: trialExpired ? 'rgba(239,83,80,0.15)' : 'rgba(52,211,153,0.15)',
                    color: trialExpired ? '#EF5350' : '#34D399',
                  }}
                />
              )}
              {isBypassed && (
                <Chip label="Bypass activo" size="small" sx={{ fontSize: '0.7rem', height: 22, backgroundColor: 'rgba(52,211,153,0.15)', color: '#34D399' }} />
              )}
            </Stack>
            {isTrialing && trialEnd && (
              <Typography sx={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.4)' }}>
                {trialExpired ? 'Tu prueba terminó el' : 'Tu prueba termina el'} {trialEnd.toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric' })}
              </Typography>
            )}
          </Box>
        </Stack>
      </Paper>

      {/* Usage */}
      <Paper sx={{ p: 2.5, mb: 3, borderRadius: '12px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <Typography sx={{ fontFamily: '"Syne", sans-serif', fontWeight: 600, fontSize: '0.95rem', color: '#E8EBF2', mb: 2 }}>
          Uso del mes
        </Typography>
        <UsageBar label="Conversaciones" current={usage.conversations || 0} max={parseInt(plan.conversations) || 1500} />
        <UsageBar label="Respuestas IA" current={usage.ai_replies || 0} max={parseInt(plan.ai_replies) || 3000} />
        <UsageBar label="Mensajes enviados" current={usage.messages_sent || 0} max={99999} />
      </Paper>

      {/* Plans */}
      <Typography sx={{ fontFamily: '"Syne", sans-serif', fontWeight: 600, fontSize: '0.95rem', color: '#E8EBF2', mb: 2 }}>
        Planes disponibles
      </Typography>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ mb: 3 }}>
        {plans.map((p: any) => {
          const isCurrent = p.code === currentPlanCode;
          const color = PLAN_COLORS[p.code] || '#E8A020';
          const features = PLAN_FEATURES[p.code] || [];

          return (
            <Paper
              key={p.code}
              sx={{
                flex: 1, p: 2.5, borderRadius: '12px',
                background: isCurrent ? 'rgba(232,160,32,0.04)' : 'rgba(255,255,255,0.02)',
                border: `1px solid ${isCurrent ? 'rgba(232,160,32,0.25)' : 'rgba(255,255,255,0.06)'}`,
                transition: 'border-color 200ms ease',
                '&:hover': { borderColor: `${color}44` },
              }}
            >
              <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1.5 }}>
                <Typography sx={{ fontFamily: '"Syne", sans-serif', fontWeight: 700, fontSize: '1.1rem', color }}>
                  {p.name}
                </Typography>
                {isCurrent && (
                  <Chip label="Actual" size="small" sx={{ fontSize: '0.65rem', fontWeight: 700, height: 20, backgroundColor: `${color}22`, color }} />
                )}
              </Stack>

              <Typography sx={{ fontFamily: '"JetBrains Mono", monospace', fontWeight: 700, fontSize: '1.6rem', color: '#E8EBF2', mb: 0.3 }}>
                {formatPrice(p.monthly_price_usd)}
              </Typography>
              <Typography sx={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.35)', mb: 2 }}>por mes + IVA</Typography>

              <Stack spacing={0.8} sx={{ mb: 2 }}>
                {features.map((f, i) => (
                  <Typography key={i} sx={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.55)', pl: 1.5, position: 'relative', '&::before': { content: '"•"', position: 'absolute', left: 0, color } }}>
                    {f}
                  </Typography>
                ))}
              </Stack>

              {!isCurrent && (
                <Button
                  fullWidth
                  variant={p.code === 'pro' ? 'contained' : 'outlined'}
                  onClick={() => handleCheckout(p.code)}
                  disabled={!!checkoutLoading}
                  sx={{
                    py: 1, fontSize: '0.85rem',
                    ...(p.code !== 'pro' && {
                      borderColor: `${color}44`,
                      color,
                      '&:hover': { borderColor: color, backgroundColor: `${color}11` },
                    }),
                  }}
                >
                  {checkoutLoading === p.code ? <CircularProgress size={18} /> : 'Elegir plan'}
                </Button>
              )}
            </Paper>
          );
        })}
      </Stack>

      <Typography sx={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.25)', textAlign: 'center' }}>
        Los pagos se procesan a través de MercadoPago. Podés cancelar en cualquier momento.
      </Typography>
    </Box>
  );
};

export default Billing;
