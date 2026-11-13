-- Client inbox: calendar notices (a client accepting / declining / moving a
-- meeting invite) aren't client emails. Rocky asked for them to be taken out;
-- sync-client-inbox now skips them, and this removes the ones already saved.
-- Safe to re-run: it only ever matches invite replies.
delete from public.client_emails
where subject ~* '^\s*((re|fw|fwd)\s*:\s*)*(accepted|declined|tentatively accepted|tentative|invitation|updated invitation[^:]*|canceled event[^:]*|cancelled event[^:]*|event cancell?ed|new event|proposed new time|meeting (accepted|declined|tentatively accepted))\s*:'
   or snippet ~* '(invitation from google calendar|has (accepted|declined|tentatively accepted) this invitation|has proposed a new time)';
