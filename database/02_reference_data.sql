-- =====================================================================
-- FILE 2 of 3: reference data (real content, keep in production)
-- Source: team's "Categories, Explanations & Reporting Guide"
-- =====================================================================

insert into countries (code, name) values
  ('PH', 'Philippines'),
  ('AU', 'Australia'),
  ('FJ', 'Fiji'),
  ('IN', 'India'),
  ('PK', 'Pakistan'),
  ('ID', 'Indonesia'),     -- language in MVP list, no legal pack yet
  ('VN', 'Vietnam');       -- language in MVP list, no legal pack yet

insert into languages (code, name) values
  ('en', 'English'),
  ('tl', 'Tagalog / Filipino'),
  ('hi', 'Hindi'),
  ('ur', 'Urdu'),
  ('fj', 'Fijian'),
  ('id', 'Indonesian'),
  ('vi', 'Vietnamese');

-- ---------------------------------------------------------------------
-- Categories and subtypes (section 1 of the guide)
-- ---------------------------------------------------------------------
insert into categories (code, name, description, key_test, sort_order) values
  ('gender_hate_speech', 'Gender Hate Speech',
   'Attacks or degrades a woman specifically through her gender.',
   'Is gender the point of the attack? "She is stupid" alone does not count.', 1),
  ('gendered_disinformation', 'Gendered Disinformation',
   'False, misleading or unverified factual claims that use gender, sexuality, family roles or stereotypes to damage her reputation.',
   'Does it make a claim that could be checked? The tool never rules on truth; it marks "verification needed".', 2),
  ('manipulated_text', 'Gendered Manipulated Text / Context',
   'Real or invented words altered or misused to attack her as a woman.',
   'Is the text altered, and is there a gender angle? Plain political misquotes are out of scope.', 3),
  ('none', 'Legitimate Criticism / None',
   'Criticism of her record, policies or decisions, however harsh.',
   'Is it about what she did, not about her being a woman?', 4);

insert into subtypes (category_code, code, name, sort_order) values
  ('gender_hate_speech', 'sexist_insult',              'Sexist insult', 1),
  ('gender_hate_speech', 'sexual_degradation',         'Sexual degradation', 2),
  ('gender_hate_speech', 'gender_based_threat',        'Gender-based threat', 3),
  ('gender_hate_speech', 'gender_role_attack',         'Gender-role attack', 4),
  ('gender_hate_speech', 'dehumanization',             'Dehumanization', 5),
  ('gender_hate_speech', 'gendered_competence_attack', 'Competence attack based on gender stereotypes', 6),
  ('gender_hate_speech', 'victim_blaming',             'Victim-blaming / mocking survivors', 7),

  ('gendered_disinformation', 'sexual_rumour',             'Sexual rumour', 1),
  ('gendered_disinformation', 'family_rumour',             'Family or motherhood rumour', 2),
  ('gendered_disinformation', 'morality_rumour',           'Morality rumour', 3),
  ('gendered_disinformation', 'competence_disinformation', 'Competence disinformation', 4),
  ('gendered_disinformation', 'identity_rumour',           'Identity rumour', 5),

  ('manipulated_text', 'misleading_quote',     'Misleading quote', 1),
  ('manipulated_text', 'fabricated_quote',     'Fabricated quote', 2),
  ('manipulated_text', 'context_manipulation', 'Context manipulation', 3),
  ('manipulated_text', 'selective_editing',    'Selective editing', 4),
  ('manipulated_text', 'misleading_framing',   'Misleading framing', 5),
  ('manipulated_text', 'false_attribution',    'False attribution', 6);

-- ---------------------------------------------------------------------
-- Legal information (section 4 of the guide)
-- ---------------------------------------------------------------------
insert into legal_info (country_code, law_name, law_url, what_it_covers, where_to_report, report_url, helpline) values
  ('PH', 'Safe Spaces Act (RA 11313)', 'https://pcw.gov.ph/faq-republic-act-no-11313/',
   'Gender-based online sexual harassment: threats, sexist remarks, cyberstalking, sharing sexual media without consent, impersonation, posting lies to harm a victim''s reputation, and filing false reports to silence victims.',
   'Philippine National Police Anti-Cybercrime Group (PNP-ACG)',
   'https://www.cybersecurityintelligence.com/philippine-national-police-anti-cybercrime-group-pnp-acg-4731.html',
   null),
  ('AU', 'Online Safety Act 2021', 'https://www.esafety.gov.au/newsroom/media-releases/new-online-safety-laws-come-force',
   'Adult cyber abuse intended to cause serious harm and that is menacing, harassing or offensive; image-based abuse.',
   'Report to the platform first; if it is not removed within 48 hours, report to eSafety.',
   'https://www.esafety.gov.au/report',
   null),
  ('FJ', 'Online Safety Act 2018', 'https://laws.gov.fj/Acts/DisplayAct/2462',
   'Online bullying and image-based abuse.',
   'Online Safety Commission complaint form',
   'https://osc.com.fj/complaints/',
   'Lifeline Fiji 1543'),
  ('IN', 'Information Technology Act and criminal law (portal route)', null,
   'Cybercrime, with a special focus on crimes against women, including online harassment.',
   'National Cyber Crime Reporting Portal',
   'https://cybercrime.gov.in/',
   '1930 (24-hour cybercrime helpline)'),
  ('PK', 'Prevention of Electronic Crimes Act 2016 (PECA)', null,
   'Cybercrime. The National Cyber Crime Investigation Agency (NCCIA) replaced the FIA Cybercrime Wing in 2024.',
   'NCCIA (confirm the current complaint process on the site)',
   'https://www.nccia.gov.pk/',
   null);

insert into platform_reporting (platform, display_name, how_to_report, link_label, report_url) values
  ('facebook', 'Facebook',
   'Use the report option on the post, comment or profile. Meta''s policy covers accounts and content created to bully or harass.',
   'Meta: Report bullying and harassment', 'https://www.meta.com/help/policies/630029231963649/'),
  ('instagram', 'Instagram',
   'Use the report option on the post, comment or profile. Meta''s policy covers accounts and content created to bully or harass.',
   'Meta: Report bullying and harassment', 'https://www.meta.com/help/policies/630029231963649/'),
  ('x', 'X',
   'Post or profile > "More" > "Report". For credible threats, contact police; X can provide a copy of the report for authorities.',
   'X: Report abusive behavior', 'https://help.x.com/en/safety-and-security/report-abusive-behavior'),
  ('tiktok', 'TikTok',
   'Video: Share > Report. Comment: tap it > Report. Account: profile > three dots > Report.',
   'Right To Be: TikTok safety guide', 'https://righttobe.org/guides/tik-tok-safety-guide/');

-- ---------------------------------------------------------------------
-- "What to do next" (section 3 of the guide)
-- Replace <WEBSITE_LINK> once the website has a URL.
-- ---------------------------------------------------------------------
insert into next_steps (guidance_key, audience, steps) values
  ('urgent', 'any', array[
    'Stay safe first. If you are in immediate danger, contact local emergency services.',
    'Save evidence now, before the post is deleted: tap "Save as evidence" to capture the screenshot, link and timestamp.',
    'Report to the platform using the link for that site.',
    'Report to the police or online-safety regulator in your country.',
    'Alert your team or UN Women country office so they can support you.',
    'Consider tightening privacy settings and removing public location details.']),
  ('gender_hate_speech', 'any', array[
    'Save as evidence.',
    'Report to the platform under harassment or hate speech.',
    'Block or mute the account if you wish.',
    'Add any new local terms to the community database (<WEBSITE_LINK>) so others are protected.',
    'Optional: visit the support community.']),
  ('gendered_disinformation', 'any', array[
    'Save as evidence.',
    'Report to the platform as false information or harassment.',
    'Check whether a fact-check exists; if one does, share the fact-check rather than the original post.',
    'Do not reshare the post, even to criticise it. Resharing spreads the claim further.',
    'If the claim damages her reputation, see the legal information for her country.']),
  ('manipulated_text', 'any', array[
    'Save as evidence, including a link to the original source if you can find it.',
    'Report to the platform as impersonation or false information.',
    'Share the original, full quote alongside a correction.']),
  ('all', 'ally', array[
    'Save evidence.',
    'Report the post.',
    'Do not engage with the attacker.',
    'Reach out to her or her organisation privately to offer support rather than replying publicly.']);
