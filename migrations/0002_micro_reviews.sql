-- Additive migration: existing enquiries and request hashes remain valid.
ALTER TABLE enquiries ADD COLUMN service_type TEXT NOT NULL DEFAULT 'paid_enquiry'
  CHECK (service_type IN ('paid_enquiry', 'free_trial'));
CREATE TABLE review_campaigns (
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  weekly_limit INTEGER NOT NULL CHECK (weekly_limit BETWEEN 1 AND 20),
  intake_limit INTEGER NOT NULL CHECK (intake_limit BETWEEN 1 AND 100)
);
INSERT INTO review_campaigns VALUES ('micro-review-v1', 1, 2, 5);
CREATE TABLE free_reviews (
  enquiry_id TEXT PRIMARY KEY REFERENCES enquiries(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL REFERENCES review_campaigns(id),
  policy_version TEXT NOT NULL,
  delivery_language TEXT NOT NULL CHECK (delivery_language='en'),
  identity_hash TEXT NOT NULL,
  duplicate_candidate INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_candidate IN (0,1)),
  review_status TEXT NOT NULL DEFAULT 'received'
    CHECK (review_status IN ('received','selected','waitlisted','unsuitable','withdrawn','delivered')),
  selection_week TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX free_reviews_identity ON free_reviews(identity_hash);
CREATE INDEX free_reviews_pending ON free_reviews(campaign_id, review_status);
-- A selected slot is retained for the week even if the project is withdrawn.
CREATE TABLE review_slots (
  enquiry_id TEXT NOT NULL REFERENCES free_reviews(enquiry_id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL REFERENCES review_campaigns(id),
  week TEXT NOT NULL CHECK (strftime('%w',week)='1' AND date(week)=week),
  PRIMARY KEY(enquiry_id, week)
);
CREATE TRIGGER trial_intake_guard BEFORE INSERT ON free_reviews
WHEN NOT EXISTS (SELECT 1 FROM free_reviews WHERE enquiry_id=NEW.enquiry_id)
BEGIN
 SELECT RAISE(ABORT, 'trial_intake_paused') WHERE NOT EXISTS (
   SELECT 1 FROM review_campaigns c WHERE c.id=NEW.campaign_id AND c.enabled=1
   AND (SELECT count(*) FROM free_reviews f WHERE f.campaign_id=c.id AND f.review_status IN ('received','waitlisted')) < c.intake_limit
 );
END;
CREATE TRIGGER trial_slot_guard BEFORE INSERT ON review_slots
WHEN NOT EXISTS (SELECT 1 FROM review_slots WHERE enquiry_id=NEW.enquiry_id AND week=NEW.week)
BEGIN
 SELECT RAISE(ABORT,'trial_week_full') WHERE (SELECT count(*) FROM review_slots WHERE campaign_id=NEW.campaign_id AND week=NEW.week)
 >= (SELECT weekly_limit FROM review_campaigns WHERE id=NEW.campaign_id)
;
END;
CREATE TRIGGER trial_selection AFTER UPDATE OF review_status, selection_week ON free_reviews
WHEN NEW.review_status IN ('selected','delivered')
BEGIN
 SELECT RAISE(ABORT,'trial_week_required') WHERE NEW.selection_week IS NULL OR strftime('%w',NEW.selection_week) IS NOT '1' OR date(NEW.selection_week) IS NOT NEW.selection_week
;
 INSERT INTO review_slots(enquiry_id,campaign_id,week) VALUES (NEW.enquiry_id,NEW.campaign_id,NEW.selection_week)
 ON CONFLICT(enquiry_id,week) DO NOTHING;
END;
