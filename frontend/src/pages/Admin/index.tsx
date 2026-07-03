import { useEffect, useState, useCallback } from 'react';
import {
  Box, Typography, Stack, Paper, Table, TableHead, TableRow, TableCell, TableBody,
  Chip, Button, Dialog, DialogTitle, DialogContent, DialogActions, Select, MenuItem,
  FormControl, InputLabel, CircularProgress, Tabs, Tab, TextField, Switch, Tooltip,
} from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../services/api';

const fmtARS = (n: number) => `$ ${Number(n || 0).toLocaleString('es-AR')}`;
const daysLeft = (iso: string | null) => {
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
};

const STATUS_COLOR: Record<string, { bg: string; fg: string }> = {
  active:   { bg: 'rgba(52,211,153,0.12)', fg: '#34D399' },
  trialing: { bg: 'rgba(232,160,32,0.12)', fg: '#E8A020' },
  past_due: { bg: 'rgba(239,83,80,0.12)',  fg: '#EF5350' },
  canceled: { bg: 'rgba(255,255,255,0.08)', fg: 'rgba(255,255,255,0.5)' },
  expired:  { bg: 'rgba(239,83,80,0.12)',  fg: '#EF5350' },
};

const Admin = () => {
  const [tab, setTab] = useState(0);
  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState<any>(null);
  const [companies, setCompanies] = useState<any[]>([]);
  const [plans, setPlans] = useState<any[]>([]);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [arcaConfigured, setArcaConfigured] = useState(false);
  const [arcaTesting, setArcaTesting] = useState(false);

  // dialog
  const [target, setTarget] = useState<any>(null);
  const [dlgPlan, setDlgPlan] = useState('');
  const [dlgStatus, setDlgStatus] = useState('');
  const [dlgExtend, setDlgExtend] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [ov, comp, pl] = await Promise.all([
        api.get('/admin/overview'),
        api.get('/admin/companies'),
        api.get('/billing/plans'),
      ]);
      setOverview(ov.data);
      setCompanies(comp.data.companies || []);
      setPlans(pl.data.plans || []);
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'Error al cargar admin');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadInvoices = useCallback(async () => {
    try {
      const { data } = await api.get('/admin/invoices');
      setInvoices(data.invoices || []);
      setArcaConfigured(!!data.arca_configured);
    } catch { /* noop */ }
  }, []);

  useEffect(() => { load(); loadInvoices(); }, [load, loadInvoices]);

  const openDialog = (c: any) => {
    setTarget(c);
    setDlgPlan(c.plan_code || 'pro');
    setDlgStatus(c.billing_status || 'trialing');
    setDlgExtend('');
  };

  const saveDialog = async () => {
    if (!target) return;
    setSaving(true);
    try {
      const body: any = {};
      if (dlgPlan && dlgPlan !== target.plan_code) body.planCode = dlgPlan;
      if (dlgStatus && dlgStatus !== target.billing_status) body.status = dlgStatus;
      if (dlgExtend && parseInt(dlgExtend) > 0) body.extendTrialDays = parseInt(dlgExtend);
      if (Object.keys(body).length === 0) { setTarget(null); setSaving(false); return; }
      await api.put(`/admin/companies/${target.id}/subscription`, body);
      toast.success(`${target.name}: suscripción actualizada`);
      setTarget(null);
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  const toggleBypass = async (c: any) => {
    try {
      await api.put(`/admin/companies/${c.id}/subscription`, { billingBypass: !c.billing_bypass });
      toast.success(`${c.name}: bypass ${!c.billing_bypass ? 'activado' : 'desactivado'}`);
      await load();
    } catch (e: any) { toast.error('Error'); }
  };

  const toggleActive = async (c: any) => {
    if (!confirm(`${c.company_active ? 'Suspender' : 'Reactivar'} la empresa "${c.name}"?`)) return;
    try {
      await api.put(`/admin/companies/${c.id}/active`, { active: !c.company_active });
      toast.success(`${c.name}: ${c.company_active ? 'suspendida' : 'reactivada'}`);
      await load();
    } catch { toast.error('Error'); }
  };

  const testArca = async () => {
    setArcaTesting(true);
    try {
      const { data } = await api.post('/admin/arca/dummy');
      if (data.ok) {
        const d = data.dummy || {};
        const wsaa = data.configured ? (data.wsaa_ok ? 'WSAA OK ✓' : `WSAA falló: ${data.wsaa_error || ''}`) : 'sin certificado (config pendiente)';
        toast.info(`ARCA ${data.env || ''}: App=${d.AppServer} DB=${d.DbServer} Auth=${d.AuthServer} · ${wsaa}`, { autoClose: 9000 });
      } else {
        toast.error(data.error || 'Error al testear ARCA');
      }
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'Error');
    } finally { setArcaTesting(false); }
  };

  if (loading) return <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress sx={{ color: '#E8A020' }} /></Box>;

  const t = overview?.totals || {};
  const cards = [
    { label: 'Empresas', value: t.companies ?? 0 },
    { label: 'Usuarios', value: t.users ?? 0 },
    { label: 'Trials activos', value: t.active_trials ?? 0 },
    { label: 'Pagando', value: t.paying ?? 0 },
    { label: 'MRR (ARS)', value: fmtARS(t.mrr_ars ?? 0) },
  ];

  return (
    <Box>
      <Typography sx={{ fontFamily: '"Sora", sans-serif', fontWeight: 700, fontSize: '1.5rem', color: '#E8EBF2' }}>
        Administración
      </Typography>
      <Typography sx={{ fontSize: '0.82rem', color: 'rgba(255,255,255,0.4)', mb: 3 }}>
        Empresas, suscripciones y facturación de la plataforma
      </Typography>

      {/* Overview */}
      <Stack direction="row" spacing={1.5} sx={{ mb: 3, flexWrap: 'wrap', gap: 1.5 }}>
        {cards.map(c => (
          <Paper key={c.label} sx={{ p: 2, px: 3, borderRadius: '12px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', minWidth: 130 }}>
            <Typography sx={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{c.label}</Typography>
            <Typography sx={{ fontFamily: '"Sora", sans-serif', fontWeight: 800, fontSize: '1.5rem', color: '#E8A020' }}>{c.value}</Typography>
          </Paper>
        ))}
      </Stack>

      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}>
        <Tab label="Empresas" />
        <Tab label={`Facturas ARCA (${invoices.length})`} />
      </Tabs>

      {tab === 0 && (
        <Paper sx={{ borderRadius: '12px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', overflow: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                {['ID', 'Empresa', 'Plan', 'Estado', 'Trial / Período', 'Uso (conv · IA)', 'Users', 'Canales', 'Bypass', 'Acciones'].map(h => (
                  <TableCell key={h} sx={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.45)', fontWeight: 700 }}>{h}</TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {companies.map(c => {
                const st = c.billing_status || c.sub_status || '—';
                const sc = STATUS_COLOR[st] || STATUS_COLOR.canceled;
                const dl = daysLeft(c.trial_ends_at);
                return (
                  <TableRow key={c.id} sx={{ opacity: c.company_active ? 1 : 0.45 }}>
                    <TableCell sx={{ fontFamily: '"JetBrains Mono", monospace', fontSize: '0.75rem' }}>{c.id}</TableCell>
                    <TableCell>
                      <Typography sx={{ fontSize: '0.85rem', fontWeight: 600 }}>{c.name}</Typography>
                      <Typography sx={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.35)' }}>{c.email}</Typography>
                    </TableCell>
                    <TableCell><Chip size="small" label={c.plan_code || 'sin plan'} sx={{ height: 20, fontSize: '0.68rem' }} /></TableCell>
                    <TableCell><Chip size="small" label={st} sx={{ height: 20, fontSize: '0.68rem', backgroundColor: sc.bg, color: sc.fg, fontWeight: 700 }} /></TableCell>
                    <TableCell sx={{ fontSize: '0.75rem' }}>
                      {st === 'trialing' && dl !== null
                        ? <span style={{ color: dl <= 5 ? '#EF5350' : '#E8A020' }}>{dl > 0 ? `${dl} días restantes` : 'vencido'}</span>
                        : (c.period_end ? new Date(c.period_end).toLocaleDateString('es-AR') : '—')}
                    </TableCell>
                    <TableCell sx={{ fontFamily: '"JetBrains Mono", monospace', fontSize: '0.75rem' }}>{c.conversations} · {c.ai_replies}</TableCell>
                    <TableCell sx={{ fontSize: '0.78rem' }}>{c.users_count}</TableCell>
                    <TableCell sx={{ fontSize: '0.78rem' }}>{c.channels_count}</TableCell>
                    <TableCell>
                      <Tooltip title="billingBypass: nunca se bloquea por suscripción">
                        <Switch size="small" checked={!!c.billing_bypass} onChange={() => toggleBypass(c)} />
                      </Tooltip>
                    </TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={0.5}>
                        <Button size="small" variant="outlined" sx={{ fontSize: '0.68rem', py: 0.2 }} onClick={() => openDialog(c)}>Gestionar</Button>
                        <Button size="small" color={c.company_active ? 'error' : 'success'} sx={{ fontSize: '0.68rem', py: 0.2 }} onClick={() => toggleActive(c)}>
                          {c.company_active ? 'Suspender' : 'Reactivar'}
                        </Button>
                      </Stack>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Paper>
      )}

      {tab === 1 && (
        <Box>
          <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 2 }}>
            <Chip
              size="small"
              label={arcaConfigured ? 'ARCA configurado' : 'ARCA sin configurar (falta certificado)'}
              sx={{ backgroundColor: arcaConfigured ? 'rgba(52,211,153,0.12)' : 'rgba(232,160,32,0.12)', color: arcaConfigured ? '#34D399' : '#E8A020', fontWeight: 600 }}
            />
            <Button size="small" variant="outlined" onClick={testArca} disabled={arcaTesting}>
              {arcaTesting ? <CircularProgress size={14} /> : 'Probar conexión ARCA'}
            </Button>
          </Stack>
          <Paper sx={{ borderRadius: '12px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', overflow: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  {['#', 'Empresa', 'Detalle', 'Monto', 'Comprobante', 'CAE', 'Estado', 'Fecha'].map(h => (
                    <TableCell key={h} sx={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.45)', fontWeight: 700 }}>{h}</TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {invoices.length === 0 ? (
                  <TableRow><TableCell colSpan={8} sx={{ color: 'rgba(255,255,255,0.35)', fontSize: '0.8rem' }}>Sin facturas todavía. Se emiten automáticamente al aprobarse un pago de MercadoPago.</TableCell></TableRow>
                ) : invoices.map(inv => (
                  <TableRow key={inv.id}>
                    <TableCell sx={{ fontFamily: '"JetBrains Mono", monospace', fontSize: '0.75rem' }}>{inv.id}</TableCell>
                    <TableCell sx={{ fontSize: '0.8rem' }}>{inv.company_name || inv.company_id}</TableCell>
                    <TableCell sx={{ fontSize: '0.78rem' }}>{inv.description}</TableCell>
                    <TableCell sx={{ fontFamily: '"JetBrains Mono", monospace', fontSize: '0.78rem' }}>{fmtARS(inv.amount)}</TableCell>
                    <TableCell sx={{ fontFamily: '"JetBrains Mono", monospace', fontSize: '0.75rem' }}>
                      {inv.cbte_nro ? `${String(inv.pto_vta).padStart(4, '0')}-${String(inv.cbte_nro).padStart(8, '0')}` : '—'}
                    </TableCell>
                    <TableCell sx={{ fontFamily: '"JetBrains Mono", monospace', fontSize: '0.72rem' }}>{inv.cae || '—'}</TableCell>
                    <TableCell>
                      <Chip size="small" label={inv.status} sx={{
                        height: 20, fontSize: '0.66rem', fontWeight: 700,
                        backgroundColor: inv.status === 'issued' ? 'rgba(52,211,153,0.12)' : inv.status === 'error' ? 'rgba(239,83,80,0.12)' : 'rgba(255,255,255,0.08)',
                        color: inv.status === 'issued' ? '#34D399' : inv.status === 'error' ? '#EF5350' : 'rgba(255,255,255,0.5)',
                      }} />
                      {inv.error && <Typography sx={{ fontSize: '0.65rem', color: '#EF5350', mt: 0.3 }}>{String(inv.error).slice(0, 60)}</Typography>}
                    </TableCell>
                    <TableCell sx={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.45)' }}>{new Date(inv.created_at).toLocaleDateString('es-AR')}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Paper>
        </Box>
      )}

      {/* Dialog gestionar suscripción */}
      <Dialog open={!!target} onClose={() => setTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontFamily: '"Sora", sans-serif', fontWeight: 700 }}>
          {target?.name}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <FormControl fullWidth size="small">
              <InputLabel>Plan</InputLabel>
              <Select value={dlgPlan} label="Plan" onChange={e => setDlgPlan(e.target.value)}>
                {plans.filter(p => !String(p.limits_json).includes('one_time')).map(p => (
                  <MenuItem key={p.code} value={p.code}>{p.name} — {fmtARS(p.monthly_price_usd)}/mes</MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl fullWidth size="small">
              <InputLabel>Estado</InputLabel>
              <Select value={dlgStatus} label="Estado" onChange={e => setDlgStatus(e.target.value)}>
                {['trialing', 'active', 'past_due', 'canceled'].map(s => <MenuItem key={s} value={s}>{s}</MenuItem>)}
              </Select>
            </FormControl>
            <TextField
              size="small" fullWidth type="number"
              label="Extender trial (días)"
              value={dlgExtend}
              onChange={e => setDlgExtend(e.target.value)}
              helperText="Suma días desde hoy o desde el vencimiento actual (lo que sea mayor)"
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setTarget(null)}>Cancelar</Button>
          <Button variant="contained" onClick={saveDialog} disabled={saving}>
            {saving ? <CircularProgress size={18} /> : 'Guardar'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default Admin;
