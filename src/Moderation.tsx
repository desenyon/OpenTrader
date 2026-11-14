import type { Group, Market } from "../shared/types";
import { post, refreshAll, useResource } from "./api";
import { ActionForm, Badge, Empty, Field, Modal } from "./ui";
import { date } from "./utils";

interface Report {
  id: string;
  market_id: string;
  comment_id: string | null;
  reason: string;
  evidence: string;
  status: string;
  created_at: string;
  decision: string | null;
  rationale: string | null;
}

export function ReportDialog({
  market,
  commentId,
  onClose,
}: {
  market: Market;
  commentId?: string;
  onClose: () => void;
}) {
  return (
    <Modal
      title={commentId ? "Report this comment" : "Report this market"}
      eyebrow="PRIVATE GROUP SAFETY"
      onClose={onClose}
    >
      <div className="modal-body">
        <p className="dialog-intro">{market.question}</p>
        <ActionForm
          submitLabel="Send to group moderators"
          onSubmit={(form) =>
            post("/reports", {
              marketId: market.id,
              commentId,
              reason: form.get("reason"),
              evidence: form.get("evidence"),
            })
          }
          onSuccess={() => {
            refreshAll();
            onClose();
          }}
        >
          <Field
            label="Reason"
            hint="Reports are visible only to your group’s moderators."
          >
            <textarea
              name="reason"
              required
              minLength={10}
              maxLength={2000}
              rows={3}
              placeholder="Explain the privacy, consent, harassment, or rules concern."
            />
          </Field>
          <Field
            label="Supporting evidence"
            hint="Avoid adding unnecessary private information."
          >
            <textarea name="evidence" maxLength={5000} rows={2} />
          </Field>
          <p className="form-footnote">
            Sensitive personal information, harmful outcomes, harassment, and
            nonconsensual markets about identifiable peers are prohibited. A
            report requests review; it does not change the published result or
            confiscate credits.
          </p>
        </ActionForm>
      </div>
    </Modal>
  );
}

export function ModerationDialog({
  group,
  onClose,
}: {
  group: Group;
  onClose: () => void;
}) {
  const reports = useResource<Report[]>(`/groups/${group.id}/reports`, 10000);
  return (
    <Modal title="Group moderation" eyebrow={group.name} onClose={onClose} wide>
      <div className="modal-body moderation-queue">
        <p className="dialog-intro">
          Review restricted reports, explain decisions, and pause unsafe
          markets. Every decision is recorded. Existing positions remain
          economically intact.
        </p>
        {reports.error && <p className="warning-note">{reports.error}</p>}
        {reports.data?.map((report) => (
          <article className="moderation-case" key={report.id}>
            <header>
              <Badge tone={report.status === "OPEN" ? "amber" : "quiet"}>
                {report.status}
              </Badge>
              <span>{date(report.created_at)}</span>
            </header>
            <p>{report.reason}</p>
            {report.evidence && (
              <details>
                <summary>Restricted evidence</summary>
                <p>{report.evidence}</p>
              </details>
            )}
            {report.status === "OPEN" ? (
              <ActionForm
                submitLabel="Record decision"
                onSubmit={(form) =>
                  post(`/reports/${report.id}/review`, {
                    decision: form.get("decision"),
                    rationale: form.get("rationale"),
                  })
                }
                onSuccess={refreshAll}
              >
                <Field label="Action">
                  <select name="decision">
                    <option value="DISMISS">Dismiss after review</option>
                    <option value="HALT_MARKET">
                      Halt market and release open-order locks
                    </option>
                    {report.comment_id && (
                      <option value="REMOVE_COMMENT">
                        Remove reported comment
                      </option>
                    )}
                  </select>
                </Field>
                <Field label="Reason for decision">
                  <textarea
                    name="rationale"
                    required
                    minLength={10}
                    maxLength={2000}
                    rows={2}
                  />
                </Field>
              </ActionForm>
            ) : (
              <p className="form-footnote">
                {report.decision} · {report.rationale}
              </p>
            )}
          </article>
        ))}
        {!reports.data?.length && (
          <Empty
            title={reports.loading ? "Loading reports" : "No reports to review"}
            detail="Your group’s restricted reports appear here."
          />
        )}
      </div>
    </Modal>
  );
}

export function PrivacyRequest() {
  const requests =
    useResource<{ id: string; request_type: string; status: string }[]>(
      "/privacy/requests",
    );
  return (
    <details className="privacy-controls">
      <summary>Data and account requests</summary>
      <p className="form-footnote">
        Download your journal immediately using Export. Account deletion
        requires operator review to anonymize identity while preserving shared
        trade integrity. Submitting a request does not delete your account
        immediately.
      </p>
      <ActionForm
        submitLabel="Record privacy request"
        onSubmit={(form) =>
          post("/privacy/requests", { type: form.get("type") })
        }
        onSuccess={refreshAll}
      >
        <Field label="Request">
          <select name="type">
            <option value="EXPORT_DATA">Full personal data export</option>
            <option value="DELETE_ACCOUNT">
              Account deletion and anonymization review
            </option>
          </select>
        </Field>
      </ActionForm>
      {requests.data?.map((request) => (
        <p className="form-footnote" key={request.id}>
          {request.request_type.replaceAll("_", " ")} · {request.status}
        </p>
      ))}
    </details>
  );
}
