begin;

update public.advisors
set disclaimer_text = 'This AI advisor is inspired by the documented ideas and philosophy of Marcus Aurelius. It is NOT Marcus Aurelius, nor an official representation of Marcus Aurelius. All responses are AI-generated based on publicly available sources.'
where slug = 'marcus-aurelius';

update public.advisors
set disclaimer_text = 'This AI advisor is inspired by the documented ideas and philosophy of Paul Graham. It is NOT Paul Graham, nor an official representation of Paul Graham. All responses are AI-generated based on publicly available sources.'
where slug = 'paul-graham';

commit;
