-- =====================================================================
-- FILE 3 of 3: demo seed data (for development and the hackathon demo)
--
-- * All people and organisations here are FICTIONAL.
-- * Slurs in languages other than English are PLACEHOLDERS
--   (e.g. PLACEHOLDER_TL_SLUR_01). Replace them only with terms a local
--   partner organisation has provided and verified.
-- * Non-English phrases (e.g. "go back to the kitchen" in Tagalog) should
--   be checked by a native speaker before any real use.
-- * Fixed IDs so teammates can hard-code them while building:
--     organisations  a0000000-...-00000000000X
--     leaders        b0000000-...-00000000000X
--     events         c0000000-...-00000000000X
-- =====================================================================

-- ---------------------------------------------------------------------
-- Organisations
-- ---------------------------------------------------------------------
insert into organizations (id, name, country_code, org_type, is_verified, verified_at, contact_email) values
  ('a0000000-0000-0000-0000-000000000001', 'Demo Women''s Rights Network (PH)',       'PH', 'ngo',             true,  now(), 'demo-network@example.org'),
  ('a0000000-0000-0000-0000-000000000002', 'UN Women Country Office PH (demo placeholder)', 'PH', 'un_women_office', true,  now(), 'demo-office@example.org'),
  ('a0000000-0000-0000-0000-000000000003', 'Demo Community Collective (IN)',          'IN', 'community_group', true,  now(), 'demo-collective@example.org'),
  ('a0000000-0000-0000-0000-000000000004', 'Unverified Test Group',                   'PH', 'community_group', false, null,  null);

-- ---------------------------------------------------------------------
-- Leaders (fictional) and events
-- ---------------------------------------------------------------------
insert into leaders (id, full_name, name_variants, public_role, country_code, organization_id) values
  ('b0000000-0000-0000-0000-000000000001', 'Maria Reyes',
   array['Minister Reyes', 'Sec. Reyes', 'Ma''am Reyes', '#ReyesResign'],
   'Minister (fictional)', 'PH', 'a0000000-0000-0000-0000-000000000002'),
  ('b0000000-0000-0000-0000-000000000002', 'Asha Verma',
   array['Dr. Verma', 'Verma ji', 'Asha ji', '#VermaOut'],
   'Member of Parliament (fictional)', 'IN', 'a0000000-0000-0000-0000-000000000003');

insert into events (id, leader_id, name, event_type, starts_at, city, alert_emails) values
  ('c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001',
   'Town hall speech on flood relief', 'speech', now() + interval '5 days', 'Quezon City',
   array['demo-alerts@example.org']),
  ('c0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000002',
   'Constituency rally', 'rally', now() + interval '10 days', 'Jaipur',
   array['demo-alerts@example.org']);

-- ---------------------------------------------------------------------
-- Lexicon: approved entries
-- ---------------------------------------------------------------------
insert into lexicon_entries
  (term, variants, entry_type, language_code, country_code, meaning,
   category_code, subtype_code, severity, is_urgent, context_note,
   status, source, approved_by_org)
values
  -- English (used across the region, so country is null)
  ('#Presstitute', array['presstitute', 'presstitutes', 'pr3sstitute', '#presstitutes'], 'hashtag', 'en', null,
   'Blend of "press" and "prostitute". Calls women journalists and politicians liars while sexualising them.',
   'gender_hate_speech', 'sexist_insult', 'high', false,
   'Documented in attacks on journalist Maria Ressa. Abusive in almost every use.',
   'approved', 'seed_demo', 'a0000000-0000-0000-0000-000000000001'),

  ('slept her way to the top', array['slept her way up', 'slept her way into', 'sleeping her way to the top', 'sl3pt her way'], 'phrase', 'en', null,
   'Claims she got her position through sex instead of merit.',
   'gendered_disinformation', 'sexual_rumour', 'high', false,
   'A checkable claim, so the pop-up says "verification needed". The tool never rules on truth.',
   'approved', 'seed_demo', 'a0000000-0000-0000-0000-000000000001'),

  ('everyone knows how she got that seat', array['we all know how she got that job', 'we know how she got there', 'everyone knows how she got that job'], 'phrase', 'en', null,
   'Implies, without evidence, that she gained her position through sexual favours.',
   'gendered_disinformation', 'sexual_rumour', 'medium', false,
   'Often paired with 🍆 or 🔥 emojis. Verification needed.',
   'approved', 'seed_demo', 'a0000000-0000-0000-0000-000000000001'),

  ('🍆🔥', array['🍆💦', '🔥🍆', '🍑🍆'], 'emoji_code', 'en', null,
   'Emoji combination with a sexual meaning.',
   'gender_hate_speech', 'sexual_degradation', 'medium', false,
   'Only flag when aimed at a woman leader. The same emojis are common in unrelated jokes.',
   'approved', 'seed_demo', 'a0000000-0000-0000-0000-000000000001'),

  ('no husband to keep her in check', array['needs a husband to control her', 'no man to keep her in line', 'no husband to control her'], 'phrase', 'en', null,
   'Links her political decisions to her marital status.',
   'gender_hate_speech', 'gendered_competence_attack', 'medium', false,
   'A gender stereotype about women leaders. A laughing emoji next to it is commonly used to mock.',
   'approved', 'seed_demo', 'a0000000-0000-0000-0000-000000000001'),

  ('too emotional to lead', array['too emotional to lead a country', 'women are too emotional', 'too emotional for politics', 'hysterical woman'], 'stereotype', 'en', null,
   'Says women can''t lead because they are "too emotional".',
   'gender_hate_speech', 'gendered_competence_attack', 'medium', false,
   'Attacks her ability because she is a woman, not because of anything she did.',
   'approved', 'seed_demo', 'a0000000-0000-0000-0000-000000000001'),

  ('go back to the kitchen', array['back to the kitchen', 'get back in the kitchen', 'make me a sandwich'], 'stereotype', 'en', null,
   'Tells her a woman''s place is at home, not in politics.',
   'gender_hate_speech', 'gender_role_attack', 'medium', false, null,
   'approved', 'seed_demo', 'a0000000-0000-0000-0000-000000000001'),

  ('attention seeker', array['just wants attention', 'playing the victim', 'attention-seeker'], 'phrase', 'en', null,
   'Mocks her for speaking about harassment.',
   'gender_hate_speech', 'victim_blaming', 'low', false,
   'Only an attack when used against her for speaking about harassment. Neutral in many other uses, so check context.',
   'approved', 'seed_demo', 'a0000000-0000-0000-0000-000000000001'),

  ('found where she lives', array['i know where she lives', 'found her address', 'here is her address', 'we know where she lives'], 'phrase', 'en', null,
   'Shares or claims to know her home location (doxxing).',
   'gender_hate_speech', 'gender_based_threat', 'high', true,
   'Treat as urgent, especially together with a call to visit or harm her.',
   'approved', 'seed_demo', 'a0000000-0000-0000-0000-000000000001'),

  ('someone should pay her a visit', array['someone should visit her', 'pay her a visit', 'she needs a visit'], 'phrase', 'en', null,
   'Implied threat suggesting someone go to her in person.',
   'gender_hate_speech', 'gender_based_threat', 'high', true,
   'Treat as urgent.',
   'approved', 'seed_demo', 'a0000000-0000-0000-0000-000000000001'),

  ('neglects her children for politics', array['abandoned her children', 'what kind of mother', 'neglecting her family', 'bad mother'], 'narrative', 'en', null,
   'Recurring claim that she is a bad mother because she works in politics.',
   'gendered_disinformation', 'family_rumour', 'medium', false,
   'Checkable claim about her family life. Verification needed.',
   'approved', 'seed_demo', 'a0000000-0000-0000-0000-000000000001'),

  ('her husband makes the decisions', array['her husband runs the ministry', 'just a puppet', 'dummy candidate', 'proxy for her husband'], 'narrative', 'en', null,
   'Recurring claim that a woman leader is only a front for a male relative.',
   'gendered_disinformation', 'competence_disinformation', 'medium', false,
   'Common narrative across South and Southeast Asia. Verification needed.',
   'approved', 'seed_demo', 'a0000000-0000-0000-0000-000000000001'),

  ('secretly a man', array['is actually a man', 'not a real woman'], 'narrative', 'en', null,
   'Rumour questioning her gender identity to humiliate her.',
   'gendered_disinformation', 'identity_rumour', 'high', false,
   'Identity rumours are also used against trans women; always harmful in this form.',
   'approved', 'seed_demo', 'a0000000-0000-0000-0000-000000000001'),

  ('homewrecker', array['home wrecker', 'home-wrecker'], 'term', 'en', null,
   'Accuses her of breaking up a marriage.',
   'gendered_disinformation', 'morality_rumour', 'medium', false,
   'A morality rumour when stated as fact about her. Verification needed.',
   'approved', 'seed_demo', 'a0000000-0000-0000-0000-000000000001'),

  ('witch', array['wicked witch', 'w1tch'], 'term', 'en', null,
   'Gendered insult.',
   'gender_hate_speech', 'sexist_insult', 'low', false,
   'Very context dependent. Only flag when aimed at a woman leader, ideally together with other markers.',
   'approved', 'seed_demo', 'a0000000-0000-0000-0000-000000000001'),

  -- Tagalog (Philippines)
  ('bumalik ka na lang sa kusina', array['balik sa kusina', 'bumalik sa kusina', 'sa kusina ka na lang'], 'stereotype', 'tl', 'PH',
   '"Just go back to the kitchen." Tells her a woman''s place is at home, not in politics.',
   'gender_hate_speech', 'gender_role_attack', 'medium', false,
   'Demo entry: to be checked by a Tagalog-speaking partner.',
   'approved', 'seed_demo', 'a0000000-0000-0000-0000-000000000001'),

  ('PLACEHOLDER_TL_SLUR_01', array['PLACEH0LDER_TL_SLUR_01', 'placeholder tl slur 01'], 'term', 'tl', 'PH',
   'Placeholder for a sexualised Tagalog slur. Replace with a partner-verified term.',
   'gender_hate_speech', 'sexist_insult', 'high', false, 'Placeholder.',
   'approved', 'seed_demo', 'a0000000-0000-0000-0000-000000000001'),

  ('PLACEHOLDER_TL_SLUR_02', array['PLACEH0LDER_TL_SLUR_02'], 'term', 'tl', 'PH',
   'Placeholder for a sexually degrading Tagalog expression. Replace with a partner-verified term.',
   'gender_hate_speech', 'sexual_degradation', 'high', false, 'Placeholder.',
   'approved', 'seed_demo', 'a0000000-0000-0000-0000-000000000001'),

  -- Hindi (India)
  ('ghar sambhalo', array['घर संभालो', 'ghar jao', 'chulha chauka sambhalo'], 'stereotype', 'hi', 'IN',
   '"Look after the home." Tells a woman to leave politics and do housework.',
   'gender_hate_speech', 'gender_role_attack', 'medium', false,
   'Demo entry: to be checked by a Hindi-speaking partner.',
   'approved', 'seed_demo', 'a0000000-0000-0000-0000-000000000003'),

  ('PLACEHOLDER_HI_SLUR_01', array['PLACEH0LDER_HI_SLUR_01'], 'term', 'hi', 'IN',
   'Placeholder for a sexualised Hindi slur. Replace with a partner-verified term.',
   'gender_hate_speech', 'sexist_insult', 'high', false, 'Placeholder.',
   'approved', 'seed_demo', 'a0000000-0000-0000-0000-000000000003'),

  -- Urdu (Pakistan)
  ('ghar baitho', array['گھر بیٹھو', 'ghar baitho aunty'], 'stereotype', 'ur', 'PK',
   '"Stay at home." Tells a woman she belongs at home, not in public life.',
   'gender_hate_speech', 'gender_role_attack', 'medium', false,
   'Demo entry: to be checked by an Urdu-speaking partner.',
   'approved', 'seed_demo', 'a0000000-0000-0000-0000-000000000001'),

  ('PLACEHOLDER_UR_SLUR_01', array['PLACEH0LDER_UR_SLUR_01'], 'term', 'ur', 'PK',
   'Placeholder for a sexualised Urdu slur. Replace with a partner-verified term.',
   'gender_hate_speech', 'sexist_insult', 'high', false, 'Placeholder.',
   'approved', 'seed_demo', 'a0000000-0000-0000-0000-000000000001'),

  -- Fijian (Fiji)
  ('PLACEHOLDER_FJ_SLUR_01', array['PLACEH0LDER_FJ_SLUR_01'], 'term', 'fj', 'FJ',
   'Placeholder for a gendered Fijian insult. Replace with a partner-verified term.',
   'gender_hate_speech', 'sexist_insult', 'high', false, 'Placeholder.',
   'approved', 'seed_demo', 'a0000000-0000-0000-0000-000000000001'),

  -- Indonesian (Indonesia)
  ('urus dapur saja', array['urus dapur aja', 'balik ke dapur'], 'stereotype', 'id', 'ID',
   '"Just take care of the kitchen." Tells her to leave politics.',
   'gender_hate_speech', 'gender_role_attack', 'medium', false,
   'Demo entry: to be checked by an Indonesian-speaking partner.',
   'approved', 'seed_demo', 'a0000000-0000-0000-0000-000000000001'),

  -- Vietnamese (Vietnam)
  ('về nhà nấu cơm đi', array['ve nha nau com di', 'về nhà nấu cơm'], 'stereotype', 'vi', 'VN',
   '"Go home and cook." Tells her a woman belongs at home.',
   'gender_hate_speech', 'gender_role_attack', 'medium', false,
   'The variant without accents matters: many people type Vietnamese without diacritics. Demo entry: to be checked by a native speaker.',
   'approved', 'seed_demo', 'a0000000-0000-0000-0000-000000000001');

-- ---------------------------------------------------------------------
-- Lexicon: review queue (pending) and a rejected poisoning attempt
-- ---------------------------------------------------------------------
insert into lexicon_entries
  (term, variants, entry_type, language_code, country_code, meaning,
   category_code, subtype_code, severity, context_note,
   status, source, raw_submission, ai_draft, reviewer_note)
values
  ('minister makeup', array['minister make-up', 'ministermakeup'], 'term', 'en', 'PH',
   'Nickname suggesting she cares about her looks, not her work.',
   'gender_hate_speech', 'gendered_competence_attack', 'medium',
   'Harmful when used to dismiss her work; check it isn''t about an actual makeup policy.',
   'pending', 'community',
   'people keep calling her "Minister Makeup", it means she only cares about looks not work',
   '{"term": "minister makeup", "variants": ["minister make-up", "ministermakeup"], "category": "gender_hate_speech", "subtype": "gendered_competence_attack", "severity": "medium", "meaning": "Nickname suggesting she cares about her looks, not her work.", "context_note": "Harmful when used to dismiss her work."}'::jsonb,
   null),

  ('PLACEHOLDER_TL_CODED_01', '{}', 'coded_expression', 'tl', 'PH',
   null, 'gendered_disinformation', 'sexual_rumour', 'medium', null,
   'pending', 'community',
   'my friends see this word under her posts a lot, it hints she has an affair with her boss',
   '{"term": "PLACEHOLDER_TL_CODED_01", "category": "gendered_disinformation", "subtype": "sexual_rumour", "severity": "medium", "meaning": "Coded hint that she is having an affair with a senior colleague."}'::jsonb,
   null),

  ('sunflower', '{}', 'term', 'en', null,
   'Submitted as a slur.', 'gender_hate_speech', 'sexist_insult', 'high', null,
   'rejected', 'community',
   'sunflower is a slur for women politicians',
   null,
   'No evidence of abusive use. Harmless word submitted as a slur; likely a lexicon poisoning attempt.');

-- ---------------------------------------------------------------------
-- Reports: a normal week of background reports (so the spike has a baseline)
-- ---------------------------------------------------------------------
insert into reports (url, platform, flagged_text, category_code, subtype_code,
                     language_code, country_code, leader_id, reporter_role,
                     screenshot_path, screenshot_sha256, reported_at)
select 'https://example.com/post/reyes-' || d || '-' || n,
       (array['facebook', 'x', 'tiktok'])[1 + (d + n) % 3],
       (array['No husband to keep her in check 😂',
              'Everyone knows how she got that seat',
              'Go back to the kitchen, Minister Reyes'])[1 + (d + n) % 3],
       (array['gender_hate_speech', 'gendered_disinformation', 'gender_hate_speech'])[1 + (d + n) % 3],
       (array['gendered_competence_attack', 'sexual_rumour', 'gender_role_attack'])[1 + (d + n) % 3],
       'en', 'PH', 'b0000000-0000-0000-0000-000000000001',
       (array['target', 'ally', 'organization'])[1 + n % 3],
       'demo/reyes-' || d || '-' || n || '.png',
       encode(sha256(convert_to('demo screenshot reyes ' || d || '-' || n, 'UTF8')), 'hex'),
       now() - make_interval(days => d, hours => n)
from generate_series(2, 7) d, generate_series(1, 1 + d % 2) n;

insert into reports (url, platform, flagged_text, category_code, subtype_code,
                     language_code, country_code, leader_id, reporter_role, reported_at)
values
  ('https://example.com/post/reyes-today-1', 'facebook',
   'Her flood-relief budget was mismanaged. Here''s the audit report.',
   'none', null, 'en', 'PH', 'b0000000-0000-0000-0000-000000000001', 'ally', now() - interval '5 hours'),
  ('https://example.com/post/reyes-today-2', 'x',
   '#Presstitute spreading fake news again',
   'gender_hate_speech', 'sexist_insult', 'en', 'PH', 'b0000000-0000-0000-0000-000000000001', 'target', now() - interval '2 hours');

-- Asha Verma: an urgent report, and the same post reported twice
-- (the second one is marked as a duplicate automatically)
insert into reports (url, platform, flagged_text, category_code, subtype_code, is_urgent,
                     language_code, country_code, leader_id, reporter_role, reported_at)
values
  ('https://example.com/post/verma-1', 'x',
   'Found where she lives. Someone should pay her a visit',
   'gender_hate_speech', 'gender_based_threat', true,
   'en', 'IN', 'b0000000-0000-0000-0000-000000000002', 'organization', now() - interval '3 days'),
  ('https://example.com/post/verma-2', 'instagram',
   'Ghar sambhalo, Dr. Verma',
   'gender_hate_speech', 'gender_role_attack', false,
   'hi', 'IN', 'b0000000-0000-0000-0000-000000000002', 'ally', now() - interval '1 day');

insert into reports (url, platform, flagged_text, category_code, subtype_code,
                     language_code, country_code, leader_id, reporter_role, reported_at)
values
  ('https://example.com/post/verma-2/', 'instagram',
   'Ghar sambhalo, Dr. Verma',
   'gender_hate_speech', 'gender_role_attack',
   'hi', 'IN', 'b0000000-0000-0000-0000-000000000002', 'target', now() - interval '20 hours');

-- ---------------------------------------------------------------------
-- One documented incident with a voice note (file itself not uploaded)
-- ---------------------------------------------------------------------
insert into incidents (id, leader_id, event_id, title, description, occurred_at, witnesses) values
  ('d0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', null,
   'Heckling and threats outside a community meeting (demo)',
   'Fictional demo incident. A group shouted sexualised insults and one person said they knew where she lived.',
   now() - interval '9 days',
   'Two staff members (names kept by her office)');

insert into incident_files (incident_id, file_path, file_kind, mime_type, size_bytes, sha256) values
  ('d0000000-0000-0000-0000-000000000001', 'demo/reyes/voice-note-001.m4a', 'voice_note', 'audio/x-m4a', 482133,
   encode(sha256(convert_to('demo voice note 001', 'UTF8')), 'hex'));
