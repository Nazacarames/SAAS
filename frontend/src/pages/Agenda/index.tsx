import { useEffect, useMemo, useState } from 'react';
import {
  Typography,
  Box,
  Paper,
  Stack,
  TextField,
  Button,
  MenuItem,
  Grid,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  ToggleButton,
  ToggleButtonGroup,
  Chip,
  Tooltip,
  Switch,
  FormControlLabel,
  Avatar,
  IconButton
} from '@mui/material';
import {
  ChevronLeft,
  ChevronRight,
  NotificationsActiveRounded as BellIcon,
  SmartToyRounded as BotIcon,
  CheckRounded as DoneIcon,
  CloseRounded as CancelIcon,
  AccessTimeRounded as ClockIcon
} from '@mui/icons-material';
import { toast } from 'react-toastify';
import api from '../../services/api';

const AMBER = '#E8A020';
const EASE = 'cubic-bezier(0.23, 1, 0.32, 1)';

const toYmd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fmtTime = (d: string | Date) => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtDateTime = (d: string) => new Date(d).toLocaleString('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

const statusMeta = (status: string): { color: 'success' | 'error' | 'warning'; label: string } => {
  const s = String(status || '').toLowerCase();
  if (s === 'completed') return { color: 'success', label: 'Completada' };
  if (s === 'cancelled') return { color: 'error', label: 'Cancelada' };
  return { color: 'warning', label: 'Pendiente' };
};

type Slot = { time: string; date: Date; appts: any[] };

const Agenda = () => {
  const [contacts, setContacts] = useState<any[]>([]);
  const [appointments, setAppointments] = useState<any[]>([]);
  const [view, setView] = useState<'calendar' | 'list'>('calendar');

  // Calendly layout state
  const [monthCursor, setMonthCursor] = useState(() => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), 1);
  });
  const [selectedDay, setSelectedDay] = useState<Date>(() => new Date());
  const [expandedSlot, setExpandedSlot] = useState<string | null>(null);
  const [showAllSlots, setShowAllSlots] = useState(false);

  // Agent business hours drive the available slot range
  const [bizHours, setBizHours] = useState<{ start: string; end: string; days: number[] } | null>(null);

  // Create dialog
  const [openNew, setOpenNew] = useState(false);
  const [prefillTime, setPrefillTime] = useState('');
  const [contactId, setContactId] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [durationMin, setDurationMin] = useState(30);
  const [notes, setNotes] = useState('');
  const [serviceType, setServiceType] = useState('visita');
  const [sendConfirmation, setSendConfirmation] = useState(true);
  const [saving, setSaving] = useState(false);

  const [detail, setDetail] = useState<any | null>(null);
  const [updatingStatus, setUpdatingStatus] = useState(false);

  const monthStart = monthCursor;
  const monthEnd = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 0);

  const load = async () => {
    try {
      const [c, a, ag] = await Promise.all([
        api.get('/contacts'),
        api.get('/ai/appointments', {
          params: {
            from_date: new Date(monthStart.getFullYear(), monthStart.getMonth(), 1).toISOString(),
            to_date: new Date(monthEnd.getFullYear(), monthEnd.getMonth(), monthEnd.getDate(), 23, 59, 59).toISOString()
          }
        }),
        api.get('/ai/agents').catch(() => ({ data: [] }))
      ]);
      setContacts(Array.isArray(c.data) ? c.data : []);
      setAppointments(Array.isArray(a.data) ? a.data : []);
      const active = (Array.isArray(ag.data) ? ag.data : []).find((x: any) => x.is_active);
      if (active?.business_hours_json) {
        try {
          const bh = JSON.parse(active.business_hours_json);
          if (bh.start && bh.end) {
            setBizHours({ start: bh.start, end: bh.end, days: Array.isArray(bh.days) && bh.days.length ? bh.days.map(Number) : [1, 2, 3, 4, 5] });
          }
        } catch { /* keep defaults */ }
      }
    } catch {
      toast.error('No se pudo cargar agenda');
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthCursor]);

  const apptsByDay = useMemo(() => {
    const map = new Map<string, any[]>();
    appointments.forEach((a: any) => {
      const key = toYmd(new Date(a.starts_at));
      const list = map.get(key) || [];
      list.push(a);
      map.set(key, list);
    });
    map.forEach((list) => list.sort((x, y) => new Date(x.starts_at).getTime() - new Date(y.starts_at).getTime()));
    return map;
  }, [appointments]);

  // ── Mini month calendar (Calendly left panel) ──────────────────────
  const monthCells = useMemo(() => {
    const offset = (monthStart.getDay() + 6) % 7;
    const cells: Array<{ day: number | null; date?: Date }> = [];
    for (let i = 0; i < offset; i++) cells.push({ day: null });
    for (let d = 1; d <= monthEnd.getDate(); d++) cells.push({ day: d, date: new Date(monthStart.getFullYear(), monthStart.getMonth(), d) });
    while (cells.length % 7 !== 0) cells.push({ day: null });
    return cells;
  }, [monthStart, monthEnd]);

  const isBizDay = (d: Date) => {
    if (!bizHours) return true;
    const iso = ((d.getDay() + 6) % 7) + 1;
    return bizHours.days.includes(iso);
  };

  // ── Day slots (Calendly right panel) ──────────────────────────────
  const slots: Slot[] = useMemo(() => {
    const startHm = bizHours?.start || '09:00';
    const endHm = bizHours?.end || '18:00';
    const [sh, sm] = startHm.split(':').map(Number);
    const [eh, em] = endHm.split(':').map(Number);

    const dayKey = toYmd(selectedDay);
    const dayAppts = apptsByDay.get(dayKey) || [];

    const out: Slot[] = [];
    const cur = new Date(selectedDay);
    cur.setHours(sh, sm, 0, 0);
    const end = new Date(selectedDay);
    end.setHours(eh, em, 0, 0);

    while (cur < end) {
      const slotStart = new Date(cur);
      const slotEnd = new Date(cur.getTime() + 30 * 60000);
      const inSlot = dayAppts.filter((a: any) => {
        const t = new Date(a.starts_at).getTime();
        return t >= slotStart.getTime() && t < slotEnd.getTime();
      });
      out.push({ time: fmtTime(slotStart), date: slotStart, appts: inSlot });
      cur.setTime(slotEnd.getTime());
    }

    // Citas fuera del rango configurado igual se muestran (arriba/abajo)
    const outOfRange = dayAppts.filter((a: any) => {
      const t = new Date(a.starts_at);
      return t < out[0]?.date || t >= end;
    });
    outOfRange.forEach((a: any) => {
      out.push({ time: fmtTime(a.starts_at), date: new Date(a.starts_at), appts: [a] });
    });
    out.sort((x, y) => x.date.getTime() - y.date.getTime());
    return out;
  }, [selectedDay, apptsByDay, bizHours]);

  const visibleSlots = useMemo(() => {
    if (showAllSlots) return slots;
    // Hide past free slots for today; always show occupied ones
    const now = Date.now();
    const isToday = toYmd(selectedDay) === toYmd(new Date());
    if (!isToday) return slots;
    return slots.filter((s) => s.appts.length > 0 || s.date.getTime() >= now);
  }, [slots, showAllSlots, selectedDay]);

  const stats = useMemo(() => {
    const now = new Date();
    const today = toYmd(now);
    const weekEnd = new Date(now);
    weekEnd.setDate(now.getDate() + 7);
    return {
      today: appointments.filter((a: any) => toYmd(new Date(a.starts_at)) === today && a.status === 'scheduled').length,
      week: appointments.filter((a: any) => {
        const x = new Date(a.starts_at).getTime();
        return x >= now.getTime() && x <= weekEnd.getTime() && a.status === 'scheduled';
      }).length,
      pending: appointments.filter((a: any) => (a.status || '') === 'scheduled').length,
      reminded: appointments.filter((a: any) => a.reminder_24h_sent_at || a.reminder_1h_sent_at).length
    };
  }, [appointments]);

  const isAgentCreated = (a: any) => Boolean(a.ticket_id);

  const openCreateAt = (slotDate: Date) => {
    const local = new Date(slotDate.getTime() - slotDate.getTimezoneOffset() * 60000);
    setPrefillTime(fmtTime(slotDate));
    setStartsAt(local.toISOString().slice(0, 16));
    setExpandedSlot(null);
    setOpenNew(true);
  };

  const createAppointment = async () => {
    if (!contactId || !startsAt) {
      toast.error('Elegí contacto y fecha/hora');
      return;
    }
    setSaving(true);
    try {
      const { data } = await api.post('/ai/appointments', {
        contactId: Number(contactId),
        startsAt: new Date(startsAt).toISOString(),
        durationMin,
        notes,
        serviceType,
        sendConfirmation
      });
      toast.success(
        data?.confirmationSent
          ? 'Cita creada y confirmación enviada por WhatsApp'
          : 'Cita creada' + (sendConfirmation ? ' (no se pudo enviar la confirmación)' : '')
      );
      setOpenNew(false);
      setNotes('');
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'No se pudo crear la cita');
    } finally {
      setSaving(false);
    }
  };

  const updateStatus = async (appt: any, status: string, notify: boolean) => {
    setUpdatingStatus(true);
    try {
      const { data } = await api.put(`/ai/appointments/${appt.id}`, { status, notifyContact: notify });
      toast.success(
        status === 'cancelled'
          ? data?.contactNotified ? 'Cita cancelada y cliente avisado por WhatsApp' : 'Cita cancelada'
          : status === 'completed' ? 'Cita marcada como completada' : 'Cita reprogramada como pendiente'
      );
      setDetail(null);
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'No se pudo actualizar la cita');
    } finally {
      setUpdatingStatus(false);
    }
  };

  const monthLabel = monthCursor.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
  const selectedLabel = selectedDay.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  const todayKey = toYmd(new Date());
  const selectedKey = toYmd(selectedDay);

  return (
    <Box>
      <Stack direction={{ xs: 'column', md: 'row' }} justifyContent='space-between' alignItems={{ xs: 'flex-start', md: 'center' }} sx={{ mb: 2, gap: 1.2 }}>
        <Box>
          <Typography variant='h4'>Agenda</Typography>
          <Typography variant='body2' color='text.secondary'>
            Elegí un día y un horario, como en Calendly. El cliente recibe confirmación y recordatorios automáticos por WhatsApp.
          </Typography>
        </Box>
        <ToggleButtonGroup size='small' value={view} exclusive onChange={(_, v) => v && setView(v)}>
          <ToggleButton value='calendar'>Calendario</ToggleButton>
          <ToggleButton value='list'>Lista</ToggleButton>
        </ToggleButtonGroup>
      </Stack>

      <Grid container spacing={2} sx={{ mb: 2 }}>
        {[
          { label: 'Hoy', value: stats.today },
          { label: 'Próximos 7 días', value: stats.week },
          { label: 'Pendientes', value: stats.pending },
          { label: 'Con recordatorio', value: stats.reminded }
        ].map((c, i) => (
          <Grid item xs={6} lg={3} key={c.label}>
            <Paper className={`anim-fade-up anim-fade-up-${i + 1}`} sx={{ p: 2 }}>
              <Typography variant='caption' color='text.secondary' sx={{ textTransform: 'uppercase', letterSpacing: 0.6, fontSize: '0.65rem' }}>{c.label}</Typography>
              <Typography variant='h5' sx={{ fontFamily: '"Syne", sans-serif', mt: 0.3 }}>{c.value}</Typography>
            </Paper>
          </Grid>
        ))}
      </Grid>

      {view === 'calendar' ? (
        <Paper className='anim-fade-up anim-fade-up-3' sx={{ p: 0, overflow: 'hidden' }}>
          <Grid container>
            {/* ── Left: month picker ───────────────────────────── */}
            <Grid item xs={12} md={5} lg={4} sx={{ borderRight: { md: '1px solid' }, borderColor: { md: 'divider' }, p: 3 }}>
              <Stack direction='row' justifyContent='space-between' alignItems='center' sx={{ mb: 2 }}>
                <Typography sx={{ fontFamily: '"Syne", sans-serif', fontWeight: 700, textTransform: 'capitalize' }}>{monthLabel}</Typography>
                <Stack direction='row' spacing={0.5}>
                  <IconButton size='small' onClick={() => setMonthCursor(new Date(monthCursor.getFullYear(), monthCursor.getMonth() - 1, 1))}><ChevronLeft fontSize='small' /></IconButton>
                  <IconButton size='small' onClick={() => setMonthCursor(new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 1))}><ChevronRight fontSize='small' /></IconButton>
                </Stack>
              </Stack>

              <Grid container columns={7} sx={{ mb: 0.5 }}>
                {['L', 'M', 'X', 'J', 'V', 'S', 'D'].map((d, i) => (
                  <Grid item xs={1} key={`${d}-${i}`} sx={{ textAlign: 'center' }}>
                    <Typography variant='caption' color='text.secondary' sx={{ fontSize: '0.65rem' }}>{d}</Typography>
                  </Grid>
                ))}
              </Grid>
              <Grid container columns={7} rowGap={0.5}>
                {monthCells.map((cell, idx) => {
                  if (!cell.date) return <Grid item xs={1} key={`e-${idx}`} />;
                  const key = toYmd(cell.date);
                  const has = (apptsByDay.get(key) || []).length > 0;
                  const isSelected = key === selectedKey;
                  const isToday = key === todayKey;
                  const biz = isBizDay(cell.date);
                  return (
                    <Grid item xs={1} key={key} sx={{ display: 'flex', justifyContent: 'center' }}>
                      <Box
                        onClick={() => { setSelectedDay(cell.date!); setExpandedSlot(null); }}
                        sx={{
                          width: 38,
                          height: 38,
                          borderRadius: '50%',
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          justifyContent: 'center',
                          cursor: 'pointer',
                          position: 'relative',
                          fontWeight: 600,
                          fontSize: '0.82rem',
                          color: isSelected ? '#0C0E12' : biz ? '#E8EBF2' : 'rgba(255,255,255,0.28)',
                          bgcolor: isSelected ? AMBER : has ? 'rgba(232,160,32,0.12)' : 'transparent',
                          border: isToday && !isSelected ? `1px solid ${AMBER}` : '1px solid transparent',
                          transition: `background-color 160ms ease, transform 140ms ${EASE}`,
                          '&:hover': { bgcolor: isSelected ? AMBER : 'rgba(232,160,32,0.20)' },
                          '&:active': { transform: 'scale(0.92)' }
                        }}
                      >
                        {cell.day}
                        {has && !isSelected && (
                          <Box sx={{ position: 'absolute', bottom: 4, width: 4, height: 4, borderRadius: '50%', bgcolor: AMBER }} />
                        )}
                      </Box>
                    </Grid>
                  );
                })}
              </Grid>

              {bizHours && (
                <Stack direction='row' spacing={0.8} alignItems='center' sx={{ mt: 2.5 }}>
                  <ClockIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
                  <Typography variant='caption' color='text.secondary'>
                    Horario del agente: {bizHours.start} – {bizHours.end} hs
                  </Typography>
                </Stack>
              )}
            </Grid>

            {/* ── Right: day slots ─────────────────────────────── */}
            <Grid item xs={12} md={7} lg={8} sx={{ p: 3, maxHeight: 560, overflowY: 'auto' }}>
              <Stack direction='row' justifyContent='space-between' alignItems='center' sx={{ mb: 2 }}>
                <Typography sx={{ fontFamily: '"Syne", sans-serif', fontWeight: 700, textTransform: 'capitalize' }}>
                  {selectedLabel}
                </Typography>
                <FormControlLabel
                  control={<Switch size='small' checked={showAllSlots} onChange={(e) => setShowAllSlots(e.target.checked)} />}
                  label={<Typography variant='caption'>Ver horarios pasados</Typography>}
                />
              </Stack>

              {!isBizDay(selectedDay) && (
                <Paper variant='outlined' sx={{ p: 1.5, mb: 2, borderColor: 'rgba(251,146,60,0.3)', bgcolor: 'rgba(251,146,60,0.05)' }}>
                  <Typography variant='caption'>
                    El agente no atiende este día según su horario configurado. Podés agendar igual: el recordatorio se envía normalmente.
                  </Typography>
                </Paper>
              )}

              <Stack spacing={0.8}>
                {visibleSlots.map((slot) => {
                  const slotKey = slot.time;
                  const occupied = slot.appts.length > 0;
                  const isPast = slot.date.getTime() < Date.now();
                  const isExpanded = expandedSlot === slotKey;

                  if (occupied) {
                    return (
                      <Stack key={slotKey} direction='row' spacing={1} alignItems='stretch'>
                        <Box sx={{ width: 52, display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                          <Typography variant='caption' sx={{ fontFamily: '"JetBrains Mono", monospace', color: AMBER, fontWeight: 600 }}>{slot.time}</Typography>
                        </Box>
                        <Stack spacing={0.6} sx={{ flex: 1 }}>
                          {slot.appts.map((a: any) => {
                            const meta = statusMeta(a.status);
                            return (
                              <Paper
                                key={a.id}
                                variant='outlined'
                                className='hover-lift'
                                onClick={() => setDetail(a)}
                                sx={{
                                  p: 1.2,
                                  cursor: 'pointer',
                                  borderColor: a.status === 'scheduled' ? 'rgba(232,160,32,0.30)' : 'divider',
                                  bgcolor: a.status === 'scheduled' ? 'rgba(232,160,32,0.06)' : 'transparent',
                                  opacity: a.status === 'cancelled' ? 0.5 : 1
                                }}
                              >
                                <Stack direction='row' spacing={1} alignItems='center'>
                                  <Avatar sx={{ width: 28, height: 28, bgcolor: 'rgba(232,160,32,0.14)', color: AMBER, fontSize: '0.75rem', fontWeight: 700 }}>
                                    {(a.contact_name || '?').slice(0, 1).toUpperCase()}
                                  </Avatar>
                                  <Box sx={{ flex: 1, minWidth: 0 }}>
                                    <Typography variant='body2' noWrap sx={{ fontWeight: 600 }}>{a.contact_name || `#${a.contact_id}`}</Typography>
                                    <Typography variant='caption' color='text.secondary'>{a.service_type || 'general'} · {meta.label}</Typography>
                                  </Box>
                                  {isAgentCreated(a) && (
                                    <Tooltip title='Agendada por el agente IA'><BotIcon sx={{ fontSize: 15, color: AMBER }} /></Tooltip>
                                  )}
                                  {(a.reminder_24h_sent_at || a.reminder_1h_sent_at) && (
                                    <Tooltip title={`Recordatorios: ${a.reminder_24h_sent_at ? '24h ✓ ' : ''}${a.reminder_1h_sent_at ? '1h ✓' : ''}`}>
                                      <BellIcon sx={{ fontSize: 15, color: '#4AB87A' }} />
                                    </Tooltip>
                                  )}
                                </Stack>
                              </Paper>
                            );
                          })}
                        </Stack>
                      </Stack>
                    );
                  }

                  // Free slot: Calendly's signature inline-confirm interaction
                  return (
                    <Stack key={slotKey} direction='row' spacing={1} alignItems='center'>
                      <Box sx={{ width: 52, flexShrink: 0 }} />
                      {isExpanded ? (
                        <Stack direction='row' spacing={1} sx={{ flex: 1, maxWidth: 360 }}>
                          <Button
                            fullWidth
                            disabled
                            sx={{
                              border: '1px solid rgba(255,255,255,0.15)',
                              color: '#E8EBF2 !important',
                              fontFamily: '"JetBrains Mono", monospace'
                            }}
                          >
                            {slot.time}
                          </Button>
                          <Button fullWidth variant='contained' className='anim-scale-in' onClick={() => openCreateAt(slot.date)}>
                            Confirmar
                          </Button>
                        </Stack>
                      ) : (
                        <Button
                          onClick={() => setExpandedSlot(slotKey)}
                          disabled={isPast && !showAllSlots}
                          sx={{
                            flex: 1,
                            maxWidth: 360,
                            justifyContent: 'center',
                            border: `1px solid ${isPast ? 'rgba(255,255,255,0.08)' : 'rgba(232,160,32,0.35)'}`,
                            color: isPast ? 'rgba(255,255,255,0.3)' : AMBER,
                            fontFamily: '"JetBrains Mono", monospace',
                            fontWeight: 600,
                            '&:hover': { borderColor: AMBER, background: 'rgba(232,160,32,0.08)' }
                          }}
                        >
                          {slot.time}
                        </Button>
                      )}
                    </Stack>
                  );
                })}
                {visibleSlots.length === 0 && (
                  <Typography variant='body2' color='text.secondary' sx={{ py: 4, textAlign: 'center' }}>
                    No quedan horarios para hoy. Elegí otro día en el calendario.
                  </Typography>
                )}
              </Stack>
            </Grid>
          </Grid>
        </Paper>
      ) : (
        <Paper className='anim-fade-up anim-fade-up-3' sx={{ p: 2.5 }}>
          <Stack spacing={1}>
            {appointments.length === 0 ? (
              <Typography variant='body2' color='text.secondary' sx={{ py: 4, textAlign: 'center' }}>No hay citas este mes.</Typography>
            ) : [...appointments].sort((x, y) => new Date(x.starts_at).getTime() - new Date(y.starts_at).getTime()).map((a: any) => {
              const meta = statusMeta(a.status);
              return (
                <Paper key={a.id} variant='outlined' className='hover-lift' onClick={() => setDetail(a)} sx={{ p: 1.5, cursor: 'pointer' }}>
                  <Stack direction={{ xs: 'column', md: 'row' }} justifyContent='space-between' alignItems={{ md: 'center' }} gap={1}>
                    <Stack direction='row' spacing={1.5} alignItems='center'>
                      <Avatar sx={{ width: 34, height: 34, bgcolor: 'rgba(232,160,32,0.14)', color: AMBER, fontSize: '0.85rem', fontWeight: 700 }}>
                        {(a.contact_name || '?').slice(0, 1).toUpperCase()}
                      </Avatar>
                      <Box>
                        <Stack direction='row' spacing={0.8} alignItems='center'>
                          <Typography variant='body2' sx={{ fontWeight: 700 }}>{a.contact_name || a.contact_id}</Typography>
                          {isAgentCreated(a) && <Tooltip title='Agendada por el agente IA'><BotIcon sx={{ fontSize: 14, color: AMBER }} /></Tooltip>}
                        </Stack>
                        <Typography variant='caption' color='text.secondary'>{fmtDateTime(a.starts_at)} · {a.service_type || 'general'}</Typography>
                      </Box>
                    </Stack>
                    <Stack direction='row' spacing={0.8} alignItems='center'>
                      {(a.reminder_24h_sent_at || a.reminder_1h_sent_at) && (
                        <Tooltip title={`Recordatorios: ${a.reminder_24h_sent_at ? '24h ✓ ' : ''}${a.reminder_1h_sent_at ? '1h ✓' : ''}`}>
                          <BellIcon sx={{ fontSize: 16, color: '#4AB87A' }} />
                        </Tooltip>
                      )}
                      <Chip size='small' label={meta.label} color={meta.color} />
                    </Stack>
                  </Stack>
                </Paper>
              );
            })}
          </Stack>
        </Paper>
      )}

      {/* New appointment (prefilled from slot) */}
      <Dialog open={openNew} onClose={() => setOpenNew(false)} maxWidth='sm' fullWidth>
        <DialogTitle>
          Nueva cita {prefillTime && <Chip size='small' label={`${selectedDay.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' })} · ${prefillTime} hs`} sx={{ ml: 1 }} />}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ mt: 1 }}>
            <TextField select label='Contacto' value={contactId} onChange={(e) => setContactId(e.target.value)}>
              {contacts.map((c: any) => (
                <MenuItem key={c.id} value={String(c.id)}>{c.name} ({c.number})</MenuItem>
              ))}
            </TextField>
            <TextField label='Fecha y hora' type='datetime-local' InputLabelProps={{ shrink: true }} value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
            <Stack direction='row' spacing={1.5}>
              <TextField label='Duración (min)' type='number' value={durationMin} onChange={(e) => setDurationMin(Number(e.target.value || 30))} sx={{ width: 150 }} />
              <TextField select label='Tipo' value={serviceType} onChange={(e) => setServiceType(e.target.value)} sx={{ flex: 1 }}>
                <MenuItem value='visita'>Visita a propiedad</MenuItem>
                <MenuItem value='reunion'>Reunión</MenuItem>
                <MenuItem value='tasacion'>Tasación</MenuItem>
                <MenuItem value='general'>General</MenuItem>
              </TextField>
            </Stack>
            <TextField label='Notas (se incluyen en el recordatorio)' value={notes} onChange={(e) => setNotes(e.target.value)} multiline minRows={2} />
            <FormControlLabel
              control={<Switch checked={sendConfirmation} onChange={(e) => setSendConfirmation(e.target.checked)} />}
              label={<Typography variant='body2'>Enviar confirmación por WhatsApp al cliente</Typography>}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpenNew(false)}>Cancelar</Button>
          <Button variant='contained' onClick={createAppointment} disabled={saving}>{saving ? 'Guardando...' : 'Crear cita'}</Button>
        </DialogActions>
      </Dialog>

      {/* Appointment detail */}
      <Dialog open={Boolean(detail)} onClose={() => setDetail(null)} maxWidth='xs' fullWidth>
        {detail && (
          <>
            <DialogTitle sx={{ pb: 1 }}>
              <Stack direction='row' spacing={1} alignItems='center'>
                <Avatar sx={{ width: 36, height: 36, bgcolor: 'rgba(232,160,32,0.14)', color: AMBER, fontWeight: 700 }}>
                  {(detail.contact_name || '?').slice(0, 1).toUpperCase()}
                </Avatar>
                <Box>
                  <Typography sx={{ fontWeight: 700, fontFamily: '"Syne", sans-serif' }}>{detail.contact_name || `Contacto #${detail.contact_id}`}</Typography>
                  <Typography variant='caption' color='text.secondary'>{detail.contact_number || ''}</Typography>
                </Box>
              </Stack>
            </DialogTitle>
            <DialogContent>
              <Stack spacing={1.2} sx={{ mt: 0.5 }}>
                <Stack direction='row' justifyContent='space-between'>
                  <Typography variant='body2' color='text.secondary'>Fecha</Typography>
                  <Typography variant='body2' sx={{ fontWeight: 600 }}>{fmtDateTime(detail.starts_at)}</Typography>
                </Stack>
                <Stack direction='row' justifyContent='space-between'>
                  <Typography variant='body2' color='text.secondary'>Tipo</Typography>
                  <Typography variant='body2'>{detail.service_type || 'general'}</Typography>
                </Stack>
                <Stack direction='row' justifyContent='space-between' alignItems='center'>
                  <Typography variant='body2' color='text.secondary'>Estado</Typography>
                  <Chip size='small' label={statusMeta(detail.status).label} color={statusMeta(detail.status).color} />
                </Stack>
                <Stack direction='row' justifyContent='space-between' alignItems='center'>
                  <Typography variant='body2' color='text.secondary'>Origen</Typography>
                  <Stack direction='row' spacing={0.5} alignItems='center'>
                    {isAgentCreated(detail) ? <BotIcon sx={{ fontSize: 15, color: AMBER }} /> : null}
                    <Typography variant='body2'>{isAgentCreated(detail) ? 'Agente IA' : 'Manual'}</Typography>
                  </Stack>
                </Stack>
                <Stack direction='row' justifyContent='space-between'>
                  <Typography variant='body2' color='text.secondary'>Recordatorios</Typography>
                  <Typography variant='body2'>
                    {detail.reminder_24h_sent_at ? '24h ✓' : '24h pendiente'} · {detail.reminder_1h_sent_at ? '1h ✓' : '1h pendiente'}
                  </Typography>
                </Stack>
                {detail.notes && (
                  <Box>
                    <Typography variant='body2' color='text.secondary'>Notas</Typography>
                    <Typography variant='body2' sx={{ whiteSpace: 'pre-wrap' }}>{detail.notes}</Typography>
                  </Box>
                )}
              </Stack>
            </DialogContent>
            <DialogActions sx={{ px: 3, pb: 2, flexWrap: 'wrap', gap: 0.5 }}>
              {detail.status === 'scheduled' && (
                <>
                  <Button size='small' startIcon={<DoneIcon />} color='success' disabled={updatingStatus} onClick={() => updateStatus(detail, 'completed', false)}>
                    Completada
                  </Button>
                  <Button size='small' startIcon={<CancelIcon />} color='error' disabled={updatingStatus} onClick={() => updateStatus(detail, 'cancelled', true)}>
                    Cancelar y avisar
                  </Button>
                </>
              )}
              {detail.status !== 'scheduled' && (
                <Button size='small' disabled={updatingStatus} onClick={() => updateStatus(detail, 'scheduled', false)}>
                  Volver a pendiente
                </Button>
              )}
              <Box sx={{ flex: 1 }} />
              <Button size='small' onClick={() => setDetail(null)}>Cerrar</Button>
            </DialogActions>
          </>
        )}
      </Dialog>
    </Box>
  );
};

export default Agenda;
