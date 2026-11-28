export interface SkillValidationResult {
    valid: boolean;
    errors: string[];
    warnings: string[];
}
/** Validates skill documents as prompt content, never as executable authority. */
export declare class SkillValidator {
    validate(content: string): SkillValidationResult;
    assertValid(content: string): void;
}
//# sourceMappingURL=SkillValidator.d.ts.map