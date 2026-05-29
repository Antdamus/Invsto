# Payroll Tax Compliance Requirements

Reviewed on 2026-05-29. This is an implementation checklist for the payroll module, not legal or accounting advice. A CPA/payroll professional should validate the rules before the system is used as the source of record for tax deposits or filings.

## Current System Position

The app already has:

- Employee records with `worker_type`, `role`, hourly rates, and active status.
- Current employee legal addresses.
- A tax-doc vault for W-4 and W-9 PDFs with access logs.
- Time-entry approval, audited adjustments, payroll periods, payroll runs, payroll lines, payment records, and printable statements.
- Employee-side FICA estimates and YTD wage tracking for finalized runs.

The app still needs structured tax data, employer-side liabilities, federal income tax withholding, state/local tax support, deposit schedules, and filing exports before it can be treated as fully payroll-tax ready.

## Official Federal Requirements To Support

- **Form W-4 / federal income tax withholding.** New employees must complete Form W-4. If no valid W-4 is provided, federal withholding defaults to single or married filing separately with no other entries. Revised W-4s must be put into effect no later than the first payroll period ending on or after 30 days from receipt. Source: IRS Topic 753 and Form W-4 pages.
- **Automated federal withholding.** Use Publication 15-T percentage-method logic for automated payroll systems. The system must store the W-4 values, annualize wages by pay period, apply credits/deductions/extra withholding, and snapshot the exact tax-table version used. Source: IRS Publication 15-T.
- **Employee and employer FICA.** For 2026, Social Security is 6.2% employee and 6.2% employer up to the $184,500 wage base. Medicare is 1.45% employee and 1.45% employer with no wage base. Additional Medicare is 0.9% employee-side only on wages over $200,000. Source: IRS Form 941 instructions / Pub. 15.
- **Commissions and seller pay.** Employee commissions are wages. They may be regular wages or supplemental wages depending on how they are paid and identified. Supplemental wage handling must support aggregate withholding and the optional flat method where allowed. Source: IRS Publication 15, section on supplemental wages.
- **FUTA.** FUTA is employer-only. Do not deduct it from employees. It applies to the first $7,000 of each employee's annual wages, with deposits generally required once quarterly FUTA liability exceeds $500. Source: IRS Form 940 / Pub. 15.
- **Form 941.** Quarterly filing must report federal income tax withheld, employee/employer Social Security, and employee/employer Medicare. Source: IRS Form 941.
- **Federal deposits.** Deposit schedule is monthly or semiweekly based on the lookback period; new employers are generally monthly unless the $100,000 next-day rule is triggered. Deposits are electronic. Source: IRS Pub. 15 and IRS employment tax due dates.
- **W-2/W-3.** W-2s must be furnished to employees and filed with SSA by January 31, with W-3 transmittal where applicable. Source: SSA W-2 filing deadlines.
- **Contractors.** Contractors/nonemployees require W-9/TIN collection and may need Form 1099-NEC. Backup withholding at 24% may apply for missing/incorrect TINs or IRS notices. Source: IRS Form W-9, Form 1099-NEC, backup withholding, and information return guidance.
- **I-9.** Every paid U.S. employee needs Form I-9 completed and retained. This is employment compliance, not payroll tax math, but it belongs in onboarding readiness. Source: USCIS I-9 guidance.

## Jurisdiction Data We Must Add

The current `store_locations` table has name, lat/lng, timezone, and policy fields, but not legal address/state/county/city. Tax compliance needs the actual work jurisdiction.

Add or confirm:

- Employer legal name, EIN, business address, payroll contact, and federal deposit schedule.
- For every store/work location: street address, city, county, state, ZIP, timezone, unemployment-tax state, withholding-tax state, and local tax jurisdictions if any.
- For every employee: legal name, SSN or secure tokenized SSN, date of birth if needed for forms, current residential address, work state(s), tax residency state, hire date, termination date, worker classification, and whether they are eligible for commission-only pay.
- For every contractor: W-9 legal name, TIN type, TIN last four/token, entity type, backup withholding status, and 1099 eligibility.

## Structured Tax Tables Needed

Create versioned tables for:

- Federal income tax withholding brackets/tables by tax year, pay frequency, filing status, and W-4 version.
- FICA constants by tax year: Social Security wage base, Social Security employee/employer rates, Medicare employee/employer rates, Additional Medicare threshold/rate.
- FUTA constants by tax year: wage base, gross rate, standard credit, effective rate, credit-reduction state support.
- State withholding rules per state and year.
- State unemployment rules per state and year: wage base, employer rate, new-employer rate, surcharge fields, and report form metadata.
- Local taxes if any work location or employee residence triggers them.
- Supplemental wage rules, including commission handling policy.

Each payroll run must snapshot the tax-table versions, W-4 values, jurisdiction values, and employer tax rates used.

## Payroll Calculation Outputs Needed

For each payroll line, store:

- Gross regular wages, overtime wages, commissions, bonuses/supplemental wages, taxable fringe benefits, reimbursements, and total taxable wages.
- Employee federal income tax withholding.
- Employee Social Security, Medicare, and Additional Medicare.
- State and local employee withholding where applicable.
- Pre-tax deductions, post-tax deductions, reimbursements, advances, garnishments, and manual adjustments.
- Net pay.
- Employer Social Security, Medicare, FUTA, SUTA/reemployment tax, and state/local employer liabilities.
- Total employer cash requirement: net pay plus taxes/reserves/fees.
- Deposit liabilities grouped by agency, form, due date, and payment status.

## Filing And Deposit Outputs Needed

The system should generate accountant/payroll exports for:

- Form 941 quarterly totals and Schedule B liability dates when semiweekly.
- Form 940 annual FUTA totals and state credit-reduction details.
- W-2/W-3 annual employee wage/tax totals.
- 1099-NEC annual contractor totals and backup withholding.
- State wage reports and unemployment reports. If Florida is a work state, support Florida RT-6 / reemployment tax reporting and the employer's assigned reemployment rate.
- Payment/deposit calendar with paid/unpaid status, confirmation numbers, and attachment storage.

## Controls And Audit Requirements

- Block payroll finalization if a required tax profile is missing: W-4 for employee, W-9 for contractor, I-9 checklist for employee, legal address, SSN/TIN token, hourly/commission rate, work jurisdiction, or state account/rate.
- Maintain effective-dated W-4 and state withholding elections instead of only PDFs.
- Keep full PDFs in private storage, but use structured extracted fields for calculations.
- Make payroll runs immutable after finalization; corrections should create adjustment/correction runs with audit notes.
- Track every manual override: who changed it, when, old value, new value, reason, and affected filing period.
- Keep tax documents and generated statements/export snapshots for the retention period the accountant chooses.
- Add reconciliation screens: payroll run totals vs. Form 941/W-2 totals, employee YTD wage bases, deposit amounts, and payment confirmations.

## Implementation Phases

1. **Compliance data model.** Add employer profile, work-location addresses, structured W-4/W-9/I-9 status, tax jurisdictions, and versioned tax constants.
2. **Federal payroll engine.** Implement Pub. 15-T federal withholding, employee/employer FICA, Additional Medicare, FUTA, commission/supplemental wage handling, and net pay.
3. **State/local engine.** Add state withholding and unemployment modules for the actual states where employees work or live.
4. **Deposit and filing layer.** Add liability calendar, deposit schedule, confirmation tracking, Form 941/940/W-2/1099/state exports, and accountant review.
5. **Admin UX.** Add payroll readiness blockers, employee tax profile drawer, tax liability dashboard, filing checklist, correction workflow, and printable/exportable pay statements.

## Source Links

- IRS Pub. 15, Employer's Tax Guide: https://www.irs.gov/publications/p15
- IRS Pub. 15-T, Federal Income Tax Withholding Methods: https://www.irs.gov/publications/p15t
- IRS Pub. 15-A, Employer's Supplemental Tax Guide: https://www.irs.gov/publications/p15a
- IRS Form W-4: https://www.irs.gov/forms-pubs/about-form-w-4
- IRS Form 941: https://www.irs.gov/form941
- IRS Form 940: https://www.irs.gov/form940
- IRS employment tax due dates: https://www.irs.gov/businesses/small-businesses-self-employed/employment-tax-due-dates
- IRS Form W-9: https://www.irs.gov/forms-pubs/about-form-w-9
- IRS Form 1099-NEC: https://www.irs.gov/form1099nec
- IRS backup withholding: https://www.irs.gov/businesses/small-businesses-self-employed/backup-withholding
- SSA W-2 filing deadlines: https://www.ssa.gov/employer/filingDeadlines.htm
- USCIS Form I-9 guidance: https://www.uscis.gov/i-9
- Florida reemployment tax, if Florida is a work state: https://floridarevenue.com/taxes/taxesfees/Pages/reemployment.aspx
